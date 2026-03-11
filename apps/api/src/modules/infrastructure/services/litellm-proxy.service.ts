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
}
