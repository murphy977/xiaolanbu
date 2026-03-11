import { Injectable } from "@nestjs/common";

import {
  LiteLlmProxyService,
  LiteLlmSpendLogRecord,
} from "../infrastructure/services/litellm-proxy.service";
import { StoreService } from "../store/store.service";
import { PriceSnapshotRecord } from "../store/models";

interface SyncWorkspaceUsageInput {
  workspaceId: string;
  limit?: number;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly storeService: StoreService,
    private readonly liteLlmProxyService: LiteLlmProxyService,
  ) {}

  async syncWorkspaceUsage(input: SyncWorkspaceUsageInput) {
    const workspace = this.storeService.getWorkspace(input.workspaceId);
    const deployments = this.storeService
      .listDeployments(workspace.id)
      .filter((item) => item.gatewayKey?.tokenId);

    if (deployments.length === 0) {
      return {
        workspace,
        synced: 0,
        skipped: 0,
        scanned: 0,
        items: [],
      };
    }

    const deploymentByTokenId = new Map(
      deployments
        .filter((item) => item.gatewayKey?.tokenId)
        .map((item) => [item.gatewayKey!.tokenId, item] as const),
    );

    const logs = await this.liteLlmProxyService.listSpendLogs(input.limit ?? 100);

    let synced = 0;
    let skipped = 0;
    const createdItems = [];

    for (const log of logs) {
      const tokenIdCandidates = this.resolveTokenIds(log);
      const deployment = tokenIdCandidates
        .map((tokenId) => deploymentByTokenId.get(tokenId))
        .find((item) => !!item);

      if (!deployment || !deployment.gatewayKey) {
        continue;
      }

      const requestId = this.resolveRequestId(log);
      if (!requestId) {
        skipped += 1;
        continue;
      }

      if (this.storeService.findUsageLedger(workspace.id, deployment.id, requestId)) {
        skipped += 1;
        continue;
      }

      const normalized = this.normalizeUsage(log);
      const pricing = this.calculatePricing({
        model: normalized.model ?? deployment.gatewayKey.modelId,
        provider: normalized.provider ?? "dashscope",
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
        cachedTokens: normalized.cachedTokens,
        cacheWriteTokens: normalized.cacheWriteTokens,
      });

      const ledger = await this.storeService.createUsageLedger({
        workspaceId: workspace.id,
        deploymentId: deployment.id,
        gatewayTokenId: deployment.gatewayKey.tokenId,
        requestId,
        provider: pricing.provider,
        model: pricing.model,
        status: normalized.status,
        startedAt: normalized.startedAt,
        finishedAt: normalized.finishedAt,
        requestDurationMs: normalized.requestDurationMs ?? undefined,
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
        totalTokens: normalized.totalTokens,
        cachedTokens: normalized.cachedTokens,
        cacheWriteTokens: normalized.cacheWriteTokens,
        reasoningTokens: normalized.reasoningTokens,
        upstreamCostCny: pricing.upstreamCostCny,
        billableCostCny: pricing.billableCostCny,
        rawSpendCny: normalized.rawSpendCny,
        currency: "CNY",
        source: "litellm",
        priceSnapshot: pricing.snapshot,
        metadata: {
          rawLog: log,
        },
      });

      if (ledger.billableCostCny > 0) {
        await this.storeService.createWalletTransaction(workspace.id, {
          type: "usage",
          title: `${deployment.name} · ${ledger.model} 调用`,
          amountCny: -ledger.billableCostCny,
          createdAt: ledger.finishedAt,
          referenceType: "usage_ledger",
          referenceId: ledger.id,
          metadata: {
            deploymentId: deployment.id,
            requestId,
            totalTokens: ledger.totalTokens,
          },
        });
      }

      synced += 1;
      createdItems.push(ledger);
    }

    await this.reconcileWorkspaceGatewayBudgets(workspace.id);

    return {
      workspace,
      synced,
      skipped,
      scanned: logs.length,
      items: createdItems,
    };
  }

  listUsageLedger(workspaceId: string, input?: { deploymentId?: string; limit?: number }) {
    return this.storeService.listUsageLedger(workspaceId, input);
  }

  listWalletTransactions(workspaceId: string, limit?: number) {
    return this.storeService.listWalletTransactions(workspaceId, limit);
  }

  listDeploymentUsageSummaries(
    workspaceId: string,
    period: "today" | "7d" | "30d" = "today",
  ) {
    return this.storeService.listDeploymentUsageSummaries(workspaceId, period);
  }

  async createWalletTopup(input: { workspaceId: string; amountCny: number; title?: string }) {
    const record = await this.storeService.createWalletTransaction(input.workspaceId, {
      type: "topup",
      title: input.title?.trim() || "余额充值",
      amountCny: input.amountCny,
      createdAt: new Date().toISOString(),
      referenceType: "topup",
      referenceId: `topup_${Date.now()}`,
    });

    await this.reconcileWorkspaceGatewayBudgets(input.workspaceId);
    return {
      wallet: this.storeService.getWallet(input.workspaceId),
      transaction: record,
    };
  }

  async createWalletAdjustment(input: { workspaceId: string; amountCny: number; title?: string }) {
    const record = await this.storeService.createWalletTransaction(input.workspaceId, {
      type: "adjustment",
      title: input.title?.trim() || "余额调整",
      amountCny: input.amountCny,
      createdAt: new Date().toISOString(),
      referenceType: "manual",
      referenceId: `adjustment_${Date.now()}`,
    });

    await this.reconcileWorkspaceGatewayBudgets(input.workspaceId);
    return {
      wallet: this.storeService.getWallet(input.workspaceId),
      transaction: record,
    };
  }

  async reconcileWorkspaceGatewayBudgets(workspaceId: string) {
    const wallet = this.storeService.getWallet(workspaceId);
    const deployments = this.storeService
      .listDeployments(workspaceId)
      .filter((item) => item.gatewayKey?.secretKey);

    const results = [];

    for (const deployment of deployments) {
      const key = deployment.gatewayKey?.secretKey;
      if (!key) {
        continue;
      }

      try {
        const info = await this.liteLlmProxyService.getVirtualKeyInfo(key);
        const currentSpend = this.asNumber(info.info.spend) ?? 0;
        const remainingBalance = Math.max(wallet.balanceCny, 0);
        const targetBudget = this.roundCurrency(currentSpend + remainingBalance);
        const shouldBlock = wallet.balanceCny <= 0;

        await this.liteLlmProxyService.updateVirtualKey({
          key,
          maxBudget: targetBudget,
          blocked: shouldBlock,
        });

        results.push({
          deploymentId: deployment.id,
          deploymentName: deployment.name,
          keyAlias: deployment.gatewayKey?.keyAlias ?? null,
          spendCny: currentSpend,
          maxBudgetCny: targetBudget,
          blocked: shouldBlock,
        });
      } catch (error) {
        results.push({
          deploymentId: deployment.id,
          deploymentName: deployment.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      workspaceId,
      walletBalanceCny: wallet.balanceCny,
      items: results,
    };
  }

  private resolveTokenIds(log: LiteLlmSpendLogRecord) {
    const metadata =
      log.metadata && typeof log.metadata === "object" ? log.metadata : ({} as Record<string, unknown>);

    return [log.api_key, metadata.user_api_key]
      .filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  private resolveRequestId(log: LiteLlmSpendLogRecord) {
    return typeof log.request_id === "string" && log.request_id.length > 0 ? log.request_id : null;
  }

  private normalizeUsage(log: LiteLlmSpendLogRecord) {
    const metadata =
      log.metadata && typeof log.metadata === "object" ? log.metadata : ({} as Record<string, unknown>);
    const usageObject =
      metadata.usage_object && typeof metadata.usage_object === "object"
        ? (metadata.usage_object as Record<string, unknown>)
        : {};
    const promptTokenDetails =
      usageObject.prompt_tokens_details && typeof usageObject.prompt_tokens_details === "object"
        ? (usageObject.prompt_tokens_details as Record<string, unknown>)
        : {};
    const completionTokenDetails =
      usageObject.completion_tokens_details && typeof usageObject.completion_tokens_details === "object"
        ? (usageObject.completion_tokens_details as Record<string, unknown>)
        : {};

    const promptTokens =
      this.asNumber(usageObject.prompt_tokens) ?? this.asNumber(log.prompt_tokens) ?? 0;
    const completionTokens =
      this.asNumber(usageObject.completion_tokens) ?? this.asNumber(log.completion_tokens) ?? 0;
    const totalTokens =
      this.asNumber(usageObject.total_tokens) ??
      this.asNumber(log.total_tokens) ??
      promptTokens + completionTokens;
    const cachedTokens = this.asNumber(promptTokenDetails.cached_tokens) ?? 0;
    const cacheWriteTokens =
      this.asNumber(promptTokenDetails.cache_creation_input_tokens) ??
      this.asNumber(promptTokenDetails.cache_write_tokens) ??
      0;
    const reasoningTokens = this.asNumber(completionTokenDetails.reasoning_tokens) ?? 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      cacheWriteTokens,
      reasoningTokens,
      provider:
        (typeof log.custom_llm_provider === "string" && log.custom_llm_provider) ||
        (typeof metadata.custom_llm_provider === "string" && metadata.custom_llm_provider) ||
        "dashscope",
      model:
        (typeof log.model_group === "string" && log.model_group) ||
        (typeof log.model === "string" && log.model) ||
        null,
      status:
        typeof log.status === "string" && log.status.toLowerCase() === "error"
          ? ("error" as const)
          : ("success" as const),
      startedAt:
        (typeof log.startTime === "string" && log.startTime) || new Date().toISOString(),
      finishedAt:
        (typeof log.endTime === "string" && log.endTime) ||
        (typeof log.startTime === "string" && log.startTime) ||
        new Date().toISOString(),
      requestDurationMs: this.asNumber(log.request_duration_ms),
      rawSpendCny: this.asNumber(log.spend) ?? 0,
    };
  }

  private calculatePricing(input: {
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
  }) {
    const normalizedModel = input.model.toLowerCase();
    const markupMultiplier = this.readMarkupMultiplier();

    if (normalizedModel !== "qwen35-plus" && normalizedModel !== "qwen3.5-plus") {
      const snapshot: PriceSnapshotRecord = {
        provider: input.provider,
        model: input.model,
        pricingVersion: "fallback-v1",
        inputTier: "unknown",
        inputPricePerMillionCny: 0,
        cachedInputPricePerMillionCny: 0,
        cacheWritePricePerMillionCny: 0,
        outputPricePerMillionCny: 0,
        markupMultiplier,
      };

      const upstreamCostCny = 0;
      return {
        provider: input.provider,
        model: input.model,
        upstreamCostCny,
        billableCostCny: 0,
        snapshot,
      };
    }

    const tier =
      input.promptTokens <= 128_000
        ? "0-128k"
        : input.promptTokens <= 256_000
          ? "128k-256k"
          : "256k-1m";

    const tierPricing =
      tier === "0-128k"
        ? { input: 0.8, output: 4.8 }
        : tier === "128k-256k"
          ? { input: 2, output: 12 }
          : { input: 4, output: 24 };

    const cacheHitPrice = tierPricing.input * 0.1;
    const cacheWritePrice = tierPricing.input * 1.25;
    const nonCachedPromptTokens = Math.max(
      input.promptTokens - input.cachedTokens - input.cacheWriteTokens,
      0,
    );

    const upstreamCostCny = this.roundCurrency(
      (nonCachedPromptTokens / 1_000_000) * tierPricing.input +
        (input.cachedTokens / 1_000_000) * cacheHitPrice +
        (input.cacheWriteTokens / 1_000_000) * cacheWritePrice +
        (input.completionTokens / 1_000_000) * tierPricing.output,
    );
    const billableCostCny = this.roundCurrency(upstreamCostCny * markupMultiplier);

    const snapshot: PriceSnapshotRecord = {
      provider: input.provider,
      model: input.model,
      pricingVersion: "aliyun-qwen35-plus-cn-mainland-2026-03",
      inputTier: tier,
      inputPricePerMillionCny: tierPricing.input,
      cachedInputPricePerMillionCny: cacheHitPrice,
      cacheWritePricePerMillionCny: cacheWritePrice,
      outputPricePerMillionCny: tierPricing.output,
      markupMultiplier,
    };

    return {
      provider: input.provider,
      model: input.model,
      upstreamCostCny,
      billableCostCny,
      snapshot,
    };
  }

  private asNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private readMarkupMultiplier() {
    const value = Number(process.env.XLB_BILLING_MARKUP_MULTIPLIER ?? "1.5");
    return Number.isFinite(value) && value > 0 ? value : 1.5;
  }

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }
}
