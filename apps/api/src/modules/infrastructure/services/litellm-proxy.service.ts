import { Readable } from "node:stream";

import { Injectable, InternalServerErrorException } from "@nestjs/common";

export interface LiteLlmVirtualKeyResult {
  key: string;
  token: string;
  keyName?: string;
  keyAlias?: string | null;
  metadata?: Record<string, unknown>;
  models: string[];
  maxBudget?: number | null;
}

export interface LiteLlmVirtualKeyInfoResult {
  key: string;
  info: {
    spend?: number;
    max_budget?: number | null;
    blocked?: boolean | null;
    key_alias?: string | null;
    key_name?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface LiteLlmSpendLogRecord {
  request_id?: string;
  api_key?: string;
  spend?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  startTime?: string;
  endTime?: string;
  request_duration_ms?: number;
  model?: string;
  model_group?: string;
  custom_llm_provider?: string;
  api_base?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

@Injectable()
export class LiteLlmProxyService {
  async proxyOpenAiRequest(input: {
    path: string;
    method: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: unknown;
  }) {
    const baseUrl = this.getProxyBaseUrl();

    if (!baseUrl) {
      throw new InternalServerErrorException(
        "LiteLLM proxy is not configured. Set LITELLM_PROXY_URL.",
      );
    }

    const targetUrl = `${baseUrl}/${input.path.replace(/^\/+/, "")}`;
    const headers = new Headers();

    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (value === undefined) {
        continue;
      }

      const lowerKey = key.toLowerCase();
      if (
        lowerKey === "host" ||
        lowerKey === "content-length" ||
        lowerKey === "connection"
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(key, item);
        }
      } else {
        headers.set(key, value);
      }
    }

    let body: BodyInit | undefined;
    const normalizedPath = input.path.replace(/^\/+/, "");
    const requestedJsonBody =
      input.body !== undefined && input.method !== "GET" && input.method !== "HEAD"
        ? this.sanitizeOpenAiPayload(input.path, input.body)
        : undefined;
    const shouldNormalizeChatStream =
      normalizedPath === "chat/completions" &&
      requestedJsonBody &&
      typeof requestedJsonBody === "object" &&
      (requestedJsonBody as Record<string, unknown>).stream === true;

    if (input.body !== undefined && input.method !== "GET" && input.method !== "HEAD") {
      headers.set("Content-Type", "application/json");
      const upstreamPayload =
        shouldNormalizeChatStream && requestedJsonBody && typeof requestedJsonBody === "object"
          ? { ...(requestedJsonBody as Record<string, unknown>), stream: false }
          : requestedJsonBody;
      body = JSON.stringify(upstreamPayload);
    }

    const response = await fetch(targetUrl, {
      method: input.method,
      headers,
      body,
      duplex: body ? "half" : undefined,
    } as RequestInit);

    if (shouldNormalizeChatStream) {
      const upstreamJson = (await response.json()) as Record<string, unknown>;
      return this.buildNormalizedChatStreamResponse({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: upstreamJson,
      });
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body ? Readable.fromWeb(response.body as never) : null,
      text: response.body ? null : await response.text(),
    };
  }

  async generateVirtualKey(input: {
    models: string[];
    maxBudget?: number;
    keyAlias?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LiteLlmVirtualKeyResult> {
    const baseUrl = this.getProxyBaseUrl();
    const masterKey = process.env.LITELLM_MASTER_KEY;

    if (!baseUrl || !masterKey) {
      throw new InternalServerErrorException(
        "LiteLLM proxy is not configured. Set LITELLM_PROXY_URL and LITELLM_MASTER_KEY.",
      );
    }

    const response = await fetch(`${baseUrl}/key/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        models: input.models,
        max_budget: input.maxBudget,
        key_alias: input.keyAlias,
        metadata: input.metadata,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new InternalServerErrorException(
        `LiteLLM key generation failed: ${response.status} ${errorBody}`,
      );
    }

    const result = (await response.json()) as Record<string, unknown>;
    const key = typeof result.key === "string" ? result.key : undefined;
    const token = typeof result.token === "string" ? result.token : undefined;

    if (!key || !token) {
      throw new InternalServerErrorException(
        "LiteLLM key generation response is missing key/token.",
      );
    }

    return {
      key,
      token,
      keyName: typeof result.key_name === "string" ? result.key_name : undefined,
      keyAlias: typeof result.key_alias === "string" ? result.key_alias : null,
      metadata:
        result.metadata && typeof result.metadata === "object"
          ? (result.metadata as Record<string, unknown>)
          : undefined,
      models: Array.isArray(result.models)
        ? result.models.filter((item): item is string => typeof item === "string")
        : input.models,
      maxBudget:
        typeof result.max_budget === "number" ? result.max_budget : input.maxBudget ?? null,
    };
  }

  async listSpendLogs(limit = 100): Promise<LiteLlmSpendLogRecord[]> {
    const baseUrl = this.getProxyBaseUrl();
    const masterKey = process.env.LITELLM_MASTER_KEY;

    if (!baseUrl || !masterKey) {
      throw new InternalServerErrorException(
        "LiteLLM proxy is not configured. Set LITELLM_PROXY_URL and LITELLM_MASTER_KEY.",
      );
    }

    const response = await fetch(`${baseUrl}/spend/logs?limit=${encodeURIComponent(String(limit))}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${masterKey}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new InternalServerErrorException(
        `LiteLLM spend logs request failed: ${response.status} ${errorBody}`,
      );
    }

    const result = (await response.json()) as unknown;
    if (Array.isArray(result)) {
      return result.filter((item): item is LiteLlmSpendLogRecord => !!item && typeof item === "object");
    }

    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as { data?: unknown[] }).data)
    ) {
      return (result as { data: unknown[] }).data.filter(
        (item): item is LiteLlmSpendLogRecord => !!item && typeof item === "object",
      );
    }

    return [];
  }

  async getVirtualKeyInfo(key: string): Promise<LiteLlmVirtualKeyInfoResult> {
    const baseUrl = this.getProxyBaseUrl();
    const masterKey = process.env.LITELLM_MASTER_KEY;

    if (!baseUrl || !masterKey) {
      throw new InternalServerErrorException(
        "LiteLLM proxy is not configured. Set LITELLM_PROXY_URL and LITELLM_MASTER_KEY.",
      );
    }

    const response = await fetch(
      `${baseUrl}/key/info?key=${encodeURIComponent(key)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${masterKey}`,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new InternalServerErrorException(
        `LiteLLM key info request failed: ${response.status} ${errorBody}`,
      );
    }

    return (await response.json()) as LiteLlmVirtualKeyInfoResult;
  }

  async updateVirtualKey(input: {
    key: string;
    maxBudget?: number;
    blocked?: boolean;
  }) {
    const baseUrl = this.getProxyBaseUrl();
    const masterKey = process.env.LITELLM_MASTER_KEY;

    if (!baseUrl || !masterKey) {
      throw new InternalServerErrorException(
        "LiteLLM proxy is not configured. Set LITELLM_PROXY_URL and LITELLM_MASTER_KEY.",
      );
    }

    const payload: Record<string, unknown> = {
      key: input.key,
    };

    if (typeof input.maxBudget === "number" && Number.isFinite(input.maxBudget)) {
      payload.max_budget = input.maxBudget;
    }

    if (typeof input.blocked === "boolean") {
      payload.blocked = input.blocked;
    }

    const response = await fetch(`${baseUrl}/key/update`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new InternalServerErrorException(
        `LiteLLM key update failed: ${response.status} ${errorBody}`,
      );
    }

    return (await response.json()) as Record<string, unknown>;
  }

  getProxyBaseUrl() {
    const value = process.env.LITELLM_PROXY_URL?.trim();
    return value ? value.replace(/\/+$/, "") : null;
  }

  getPublicBaseUrl() {
    const value =
      process.env.XLB_GATEWAY_PUBLIC_BASE_URL?.trim() ??
      process.env.LITELLM_PUBLIC_BASE_URL?.trim();
    return value ? value.replace(/\/+$/, "") : null;
  }

  private sanitizeOpenAiPayload(path: string, payload: unknown) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const normalizedPath = path.replace(/^\/+/, "");
    if (normalizedPath !== "chat/completions") {
      return payload;
    }

    const next = { ...(payload as Record<string, unknown>) };
    if (Array.isArray(next.tools) && next.tools.length === 0) {
      delete next.tools;

      if (next.tool_choice !== undefined) {
        delete next.tool_choice;
      }

      if (next.parallel_tool_calls !== undefined) {
        delete next.parallel_tool_calls;
      }
    }

    const model = typeof next.model === "string" ? next.model : "";
    if (model.startsWith("qwen") && next.enable_thinking === undefined) {
      next.enable_thinking = false;
    }

    return next;
  }

  private buildNormalizedChatStreamResponse(input: {
    status: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }) {
    const message =
      Array.isArray(input.body.choices) && input.body.choices[0] && typeof input.body.choices[0] === "object"
        ? ((input.body.choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined)
        : undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    const completionId = typeof input.body.id === "string" ? input.body.id : "chatcmpl-xlb";
    const created =
      typeof input.body.created === "number" ? input.body.created : Math.floor(Date.now() / 1000);
    const model = typeof input.body.model === "string" ? input.body.model : "unknown";

    const chunks = [
      this.formatSseChunk({
        id: completionId,
        created,
        model,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" } }],
      }),
      ...(content
        ? [
            this.formatSseChunk({
              id: completionId,
              created,
              model,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content } }],
            }),
          ]
        : []),
      this.formatSseChunk({
        id: completionId,
        created,
        model,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      "data: [DONE]\n\n",
    ];

    return {
      status: input.status,
      headers: {
        ...input.headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
      body: Readable.from(chunks),
      text: null,
    };
  }

  private formatSseChunk(payload: Record<string, unknown>) {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
}
