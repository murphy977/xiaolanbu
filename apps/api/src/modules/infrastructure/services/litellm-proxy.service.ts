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
