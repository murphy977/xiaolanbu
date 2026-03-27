import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { URL } from "node:url";

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";

import { DeploymentRecord } from "../../store/models";
import { StoreService } from "../../store/store.service";

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
  private readonly logger = new Logger(LiteLlmProxyService.name);

  constructor(private readonly storeService: StoreService) {}

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
    this.logger.log(
      `forwarding ${input.method} ${input.path.replace(/^\/+/, "")} -> ${targetUrl}`,
    );
    const headers: Record<string, string> = {};

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
        headers[key] = value.join(", ");
      } else {
        headers[key] = value;
      }
    }

    let body: string | undefined;
    const normalizedPath = input.path.replace(/^\/+/, "");
    const requestedJsonBody =
      input.body !== undefined && input.method !== "GET" && input.method !== "HEAD"
        ? await this.sanitizeOpenAiPayload(input.path, input.body, input.headers)
        : undefined;
    if (input.body !== undefined && input.method !== "GET" && input.method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(requestedJsonBody);
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    return await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Readable | null;
      text: string | null;
    }>((resolve, reject) => {
      const url = new URL(targetUrl);
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port ? Number(url.port) : undefined,
          path: `${url.pathname}${url.search}`,
          method: input.method,
          headers,
        },
        (response) => {
          this.logger.log(
            `upstream responded ${input.method} ${normalizedPath} status=${response.statusCode ?? 502}`,
          );
          resolve({
            status: response.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(response.headers).flatMap(([key, value]) => {
                if (value === undefined) {
                  return [];
                }

                return [[key, Array.isArray(value) ? value.join(", ") : String(value)]];
              }),
            ),
            body: response,
            text: null,
          });
        },
      );

      request.on("error", (error) => {
        this.logger.error(
          `proxy request failed path=${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        reject(error);
      });

      request.setTimeout(60_000, () => {
        request.destroy(new Error(`Proxy request timed out for ${normalizedPath}`));
      });

      if (body) {
        request.write(body);
      }

      request.end();
    });
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

  getStableModelAlias() {
    return process.env.XLB_GATEWAY_MODEL_ALIAS?.trim() || "openclaw";
  }

  private async sanitizeOpenAiPayload(
    path: string,
    payload: unknown,
    headers?: Record<string, string | string[] | undefined>,
  ) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const normalizedPath = path.replace(/^\/+/, "");
    if (normalizedPath !== "chat/completions") {
      return payload;
    }

    const next = { ...(payload as Record<string, unknown>) };
    const routedModel = await this.resolveDeploymentRoutedModel(normalizedPath, next, headers);
    if (routedModel) {
      next.model = routedModel.modelId;
      this.logger.log(
        `rewrote gateway model alias ${routedModel.alias} -> ${routedModel.modelId} for deployment ${routedModel.deploymentId}`,
      );
    }

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

  private async resolveDeploymentRoutedModel(
    normalizedPath: string,
    payload: Record<string, unknown>,
    headers?: Record<string, string | string[] | undefined>,
  ) {
    if (normalizedPath !== "chat/completions") {
      return null;
    }

    const requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
    const stableAlias = this.getStableModelAlias();
    if (!requestedModel || requestedModel !== stableAlias) {
      return null;
    }

    const bearerKey = this.extractBearerToken(headers);
    if (!bearerKey) {
      throw new BadRequestException("当前请求缺少可识别的网关 key，无法解析 deployment 模型。");
    }

    const deployment = await this.storeService.getDeploymentByGatewaySecretAsync(bearerKey);
    if (!deployment) {
      throw new BadRequestException("当前网关 key 没有关联 deployment，无法解析实际模型。");
    }

    const modelId = this.resolveDeploymentModelId(deployment);
    if (!modelId) {
      throw new BadRequestException(`deployment ${deployment.id} 缺少可用模型配置。`);
    }

    return {
      alias: stableAlias,
      deploymentId: deployment.id,
      modelId,
    };
  }

  private extractBearerToken(headers?: Record<string, string | string[] | undefined>) {
    if (!headers) {
      return null;
    }

    const authorizationHeader =
      headers.authorization ??
      headers.Authorization ??
      headers.AUTHORIZATION;
    const rawAuthorization = Array.isArray(authorizationHeader)
      ? authorizationHeader[0]
      : authorizationHeader;
    if (typeof rawAuthorization !== "string" || !rawAuthorization.trim()) {
      return null;
    }

    const match = rawAuthorization.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
  }

  private resolveDeploymentModelId(deployment: DeploymentRecord) {
    const gatewayKey =
      deployment.gatewayKey && typeof deployment.gatewayKey === "object"
        ? deployment.gatewayKey
        : undefined;
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object"
        ? deployment.metadata
        : {};
    const modelId =
      (typeof gatewayKey?.modelId === "string" && gatewayKey.modelId.trim()) ||
      (typeof metadata.modelId === "string" && metadata.modelId.trim()) ||
      process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() ||
      process.env.XLB_GATEWAY_MODEL?.trim() ||
      "gpt-5.2";

    return modelId || null;
  }
}
