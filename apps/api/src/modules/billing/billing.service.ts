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

interface SyncUserUsageInput {
  userId: string;
  limit?: number;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly storeService: StoreService,
    private readonly liteLlmProxyService: LiteLlmProxyService,
  ) {}

  async syncWorkspaceUsage(input: SyncWorkspaceUsageInput) {
    const workspace = await this.storeService.getWorkspaceAsync(input.workspaceId);
    const billingUserId = await this.storeService.getBillingUserIdForWorkspaceAsync(workspace.id);
    const result = await this.syncUserUsage({
      userId: billingUserId,
      limit: input.limit,
    });

    return {
      workspace,
      workspaceId: workspace.id,
      ...result,
    };
  }

  async syncUserUsage(input: SyncUserUsageInput) {
    const billingUserId = input.userId;
    const accountScopeId = await this.storeService.getPreferredWorkspaceIdForUserAsync(billingUserId);
    const deployments = (await this.storeService.listDeploymentsOwnedByUserAsync(billingUserId))
      .filter((item) => item.gatewayKey?.tokenId);
    const localCredentials = (await this.storeService.listLocalGatewayCredentialsAsync({
      userId: billingUserId,
    })).filter((item) => item.status !== "disabled");
    const accountScopeIds = new Set(
      (await this.storeService.listUserWorkspacesAsync(billingUserId)).map((item) => item.id),
    );

    const deploymentByTokenId = new Map(
      deployments
        .filter((item) => item.gatewayKey?.tokenId)
        .map((item) => [item.gatewayKey!.tokenId, item] as const),
    );
    const localCredentialByTokenId = new Map(
      localCredentials.map((item) => [item.tokenId, item] as const),
    );

    const logs = await this.liteLlmProxyService.listSpendLogs(
      this.resolveGatewayLogLimit(input.limit),
    );
    await this.reconcileLoggedGatewayKeys({
      workspaceIds: accountScopeIds,
      userId: billingUserId,
      logs,
      walletBalanceCny: (await this.storeService.getWalletByUserIdAsync(billingUserId)).balanceCny,
    });

    let synced = 0;
    let skipped = 0;
    const createdItems = [];

    for (const log of logs) {
      const tokenIdCandidates = this.resolveTokenIds(log);
      const deployment = tokenIdCandidates
        .map((tokenId) => deploymentByTokenId.get(tokenId))
        .find((item) => !!item);
      const localCredential = !deployment
        ? tokenIdCandidates.map((tokenId) => localCredentialByTokenId.get(tokenId)).find((item) => !!item)
        : null;

      if (!deployment && !localCredential) {
        continue;
      }

      const requestId = this.resolveRequestId(log);
      if (!requestId) {
        skipped += 1;
        continue;
      }

      const normalized = this.normalizeUsage(log);
      const pricing = this.calculatePricing({
        model:
          normalized.model ??
          deployment?.gatewayKey?.modelId ??
          localCredential?.defaultModelId ??
          "gpt-5.2",
        provider: normalized.provider ?? "openai",
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
        cachedTokens: normalized.cachedTokens,
        cacheWriteTokens: normalized.cacheWriteTokens,
        rawSpendCny: normalized.rawSpendCny,
      });

      const workspaceId = localCredential?.accountScopeId ?? deployment?.workspaceId ?? accountScopeId;
      const effectiveDeploymentId = localCredential
        ? `local:${localCredential.accountScopeId}`
        : deployment!.id;
      const gatewayTokenId = localCredential?.tokenId ?? deployment?.gatewayKey?.tokenId;
      const chargeTitle = localCredential
        ? `本地 OpenClaw · ${pricing.model} 调用`
        : `${deployment!.name} · ${pricing.model} 调用`;

      const usageResult = await this.storeService.recordUsageAndCharge({
        userId: billingUserId,
        ledger: {
          workspaceId,
          userId: billingUserId,
          deploymentId: effectiveDeploymentId,
          gatewayTokenId,
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
            client_scope: localCredential ? "local" : "cloud",
            account_scope_id: localCredential?.accountScopeId,
            local_device_id:
              localCredential?.metadata &&
              typeof localCredential.metadata.localDeviceId === "string"
                ? localCredential.metadata.localDeviceId
                : undefined,
            rawLog: log,
          },
        },
        charge:
          pricing.billableCostCny > 0
            ? {
                workspaceId,
                type: "usage",
                title: chargeTitle,
                amountCny: -pricing.billableCostCny,
                createdAt: normalized.finishedAt,
                referenceType: "usage_ledger",
                referenceId: requestId,
                metadata: {
                  deploymentId: effectiveDeploymentId,
                  client_scope: localCredential ? "local" : "cloud",
                  requestId,
                  totalTokens: normalized.totalTokens,
                },
              }
            : undefined,
      });

      if (!usageResult.created) {
        skipped += 1;
        continue;
      }

      const ledger = usageResult.ledger;
      synced += 1;
      createdItems.push(ledger);
    }

    await this.reconcileUserGatewayBudgets(billingUserId);

    return {
      userId: billingUserId,
      accountScopeId,
      synced,
      skipped,
      scanned: logs.length,
      items: createdItems,
    };
  }

  async listUsageLedger(workspaceId: string, input?: { deploymentId?: string; limit?: number }) {
    return this.storeService.listUsageLedgerAsync(workspaceId, input);
  }

  async listWalletTransactions(workspaceId: string, limit?: number) {
    return this.storeService.listWalletTransactionsAsync(workspaceId, limit);
  }

  async listDeploymentUsageSummaries(
    workspaceId: string,
    period: "today" | "7d" | "30d" = "today",
  ) {
    return this.storeService.listDeploymentUsageSummariesAsync(workspaceId, period);
  }

  async getUserUsageSummaryWithLocal(userId: string, period: "today" | "7d" | "30d" = "today") {
    const accountScopeId = await this.storeService.getPreferredWorkspaceIdForUserAsync(userId);
    return {
      summary: await this.storeService.getUsageSummaryByUserIdAsync(userId, period, accountScopeId),
      localUsage: await this.buildLocalUsageSummary(userId, period, accountScopeId),
    };
  }

  async createWalletTopup(input: { workspaceId: string; amountCny: number; title?: string }) {
    const billingUserId = await this.storeService.getBillingUserIdForWorkspaceAsync(input.workspaceId);
    return this.createWalletTopupForUser({
      userId: billingUserId,
      amountCny: input.amountCny,
      title: input.title,
      workspaceId: input.workspaceId,
    });
  }

  async createWalletTopupForUser(input: {
    userId: string;
    amountCny: number;
    title?: string;
    workspaceId?: string;
  }) {
    const workspaceId =
      input.workspaceId || (await this.storeService.getPreferredWorkspaceIdForUserAsync(input.userId));
    const record = await this.storeService.createWalletTransactionForUser(input.userId, {
      workspaceId,
      type: "topup",
      title: input.title?.trim() || "余额充值",
      amountCny: input.amountCny,
      createdAt: new Date().toISOString(),
      referenceType: "topup",
      referenceId: `topup_${Date.now()}`,
    });

    await this.reconcileUserGatewayBudgets(input.userId);
    return {
      wallet: await this.storeService.getWalletByUserIdAsync(input.userId),
      transaction: record,
    };
  }

  async createWalletAdjustment(input: { workspaceId: string; amountCny: number; title?: string }) {
    const billingUserId = await this.storeService.getBillingUserIdForWorkspaceAsync(input.workspaceId);
    return this.createWalletAdjustmentForUser({
      userId: billingUserId,
      amountCny: input.amountCny,
      title: input.title,
      workspaceId: input.workspaceId,
    });
  }

  async createWalletAdjustmentForUser(input: {
    userId: string;
    amountCny: number;
    title?: string;
    workspaceId?: string;
  }) {
    const workspaceId =
      input.workspaceId || (await this.storeService.getPreferredWorkspaceIdForUserAsync(input.userId));
    const record = await this.storeService.createWalletTransactionForUser(input.userId, {
      workspaceId,
      type: "adjustment",
      title: input.title?.trim() || "余额调整",
      amountCny: input.amountCny,
      createdAt: new Date().toISOString(),
      referenceType: "manual",
      referenceId: `adjustment_${Date.now()}`,
    });

    await this.reconcileUserGatewayBudgets(input.userId);
    return {
      wallet: await this.storeService.getWalletByUserIdAsync(input.userId),
      transaction: record,
    };
  }

  async reconcileWorkspaceGatewayBudgets(workspaceId: string) {
    const userId = await this.storeService.getBillingUserIdForWorkspaceAsync(workspaceId);
    const result = await this.reconcileUserGatewayBudgets(userId);
    return {
      workspaceId,
      ...result,
    };
  }

  async reconcileUserGatewayBudgets(userId: string) {
    const wallet = await this.storeService.getWalletByUserIdAsync(userId);
    const accountScopeIds = new Set((await this.storeService.listUserWorkspacesAsync(userId)).map((item) => item.id));
    const deployments = (await this.storeService.listDeploymentsOwnedByUserAsync(userId))
      .filter((item) => item.gatewayKey?.secretKey);
    const localCredentials = (await this.storeService.listLocalGatewayCredentialsAsync({
      userId,
    })).filter((item) => item.status !== "disabled" && item.secretKey);

    const results = [];
    const seenKeys = new Set<string>();

    for (const deployment of deployments) {
      const key = deployment.gatewayKey?.secretKey;
      if (!key) {
        continue;
      }
      seenKeys.add(key);

      try {
        const info = await this.liteLlmProxyService.getVirtualKeyInfo(key);
        if (!this.matchesGatewayKeyOwner(info.info.metadata, userId, accountScopeIds)) {
          continue;
        }
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

    for (const credential of localCredentials) {
      const key = credential.secretKey;
      if (!key) {
        continue;
      }
      seenKeys.add(key);

      try {
        const info = await this.liteLlmProxyService.getVirtualKeyInfo(key);
        if (!this.matchesGatewayKeyOwner(info.info.metadata, userId, accountScopeIds)) {
          continue;
        }
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
          deploymentId: `local:${credential.accountScopeId}`,
          deploymentName: "本地 OpenClaw",
          keyAlias:
            credential.metadata && typeof credential.metadata.keyAlias === "string"
              ? credential.metadata.keyAlias
              : null,
          spendCny: currentSpend,
          maxBudgetCny: targetBudget,
          blocked: shouldBlock,
          scope: "local",
        });
      } catch (error) {
        results.push({
          deploymentId: `local:${credential.accountScopeId}`,
          deploymentName: "本地 OpenClaw",
          scope: "local",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const logs = await this.liteLlmProxyService.listSpendLogs(this.resolveGatewayLogLimit());
    const recovered = await this.reconcileLoggedGatewayKeys({
      workspaceIds: accountScopeIds,
      userId,
      logs,
      walletBalanceCny: wallet.balanceCny,
      seenKeys,
    });
    results.push(...recovered);

    return {
      userId,
      walletBalanceCny: wallet.balanceCny,
      items: results,
    };
  }

  private async reconcileLoggedGatewayKeys(input: {
    workspaceIds: Set<string>;
    userId: string;
    logs: LiteLlmSpendLogRecord[];
    walletBalanceCny: number;
    seenKeys?: Set<string>;
  }) {
    const candidates = new Map<string, { keyAlias: string | null }>();

    for (const log of input.logs) {
      const metadata =
        log.metadata && typeof log.metadata === "object"
          ? (log.metadata as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      const workspaceId =
        typeof metadata.workspace_id === "string" && metadata.workspace_id.length > 0
          ? metadata.workspace_id
          : null;
      const userId =
        typeof metadata.user_id === "string" && metadata.user_id.length > 0 ? metadata.user_id : null;

      if (!userId && !workspaceId) {
        continue;
      }

      if (userId && userId !== input.userId) {
        continue;
      }

      if (!userId && workspaceId && !input.workspaceIds.has(workspaceId)) {
        continue;
      }

      const keyAlias =
        typeof metadata.user_api_key_alias === "string" && metadata.user_api_key_alias.length > 0
          ? metadata.user_api_key_alias
          : null;
      if (!(keyAlias?.startsWith("deployment:") || keyAlias?.startsWith("local:"))) {
        continue;
      }

      for (const key of this.resolveTokenIds(log)) {
        if (input.seenKeys?.has(key) || candidates.has(key)) {
          continue;
        }

        candidates.set(key, { keyAlias });
      }
    }

    const remainingBalance = Math.max(input.walletBalanceCny, 0);
    const shouldBlock = input.walletBalanceCny <= 0;
    const items = [];

    for (const [key, candidate] of candidates) {
      input.seenKeys?.add(key);

      try {
        const info = await this.liteLlmProxyService.getVirtualKeyInfo(key);
        if (!this.matchesGatewayKeyOwner(info.info.metadata, input.userId, input.workspaceIds)) {
          continue;
        }
        const currentSpend = this.asNumber(info.info.spend) ?? 0;
        const targetBudget = this.roundCurrency(currentSpend + remainingBalance);
        const blocked = info.info.blocked === true;
        const maxBudget = this.asNumber(info.info.max_budget);
        const needsBudgetUpdate =
          typeof maxBudget !== "number" || Math.abs(maxBudget - targetBudget) > 0.000001;
        const needsBlockUpdate = blocked !== shouldBlock;

        if (needsBudgetUpdate || needsBlockUpdate) {
          await this.liteLlmProxyService.updateVirtualKey({
            key,
            maxBudget: targetBudget,
            blocked: shouldBlock,
          });
        }

        items.push({
          keyAlias: typeof info.info.key_alias === "string" ? info.info.key_alias : candidate.keyAlias,
          spendCny: currentSpend,
          maxBudgetCny: targetBudget,
          blocked: shouldBlock,
          source: "log-reconcile",
        });
      } catch (error) {
        items.push({
          keyAlias: candidate.keyAlias,
          source: "log-reconcile",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return items;
  }

  private resolveTokenIds(log: LiteLlmSpendLogRecord) {
    const metadata =
      log.metadata && typeof log.metadata === "object" ? log.metadata : ({} as Record<string, unknown>);

    return [log.api_key, metadata.user_api_key]
      .filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  private matchesGatewayKeyOwner(
    metadata: Record<string, unknown> | undefined,
    userId: string,
    workspaceIds: Set<string>,
  ) {
    const normalizedMetadata =
      metadata && typeof metadata === "object" ? metadata : ({} as Record<string, unknown>);
    const keyUserId =
      typeof normalizedMetadata.user_id === "string" && normalizedMetadata.user_id.length > 0
        ? normalizedMetadata.user_id
        : null;
    const keyWorkspaceId =
      typeof normalizedMetadata.workspace_id === "string" && normalizedMetadata.workspace_id.length > 0
        ? normalizedMetadata.workspace_id
        : null;

    if (keyUserId) {
      return keyUserId === userId;
    }

    if (keyWorkspaceId) {
      return workspaceIds.has(keyWorkspaceId);
    }

    return false;
  }

  private resolveGatewayLogLimit(requestedLimit?: number) {
    const configuredLimit = Number(process.env.XLB_BILLING_SYNC_LIMIT ?? 500);
    const safeConfiguredLimit =
      Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 500;
    const safeRequestedLimit =
      typeof requestedLimit === "number" && Number.isFinite(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : safeConfiguredLimit;

    return Math.max(safeRequestedLimit, safeConfiguredLimit, 500);
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
        "openai",
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
    rawSpendCny: number;
  }) {
    const normalizedModel = input.model.toLowerCase();
    const markupMultiplier = this.readMarkupMultiplier();

    if (normalizedModel !== "qwen35-plus" && normalizedModel !== "qwen3.5-plus") {
      const snapshot: PriceSnapshotRecord = {
        provider: input.provider,
        model: input.model,
        pricingVersion: "logged-spend-fallback-v1",
        inputTier: "unknown",
        inputPricePerMillionCny: 0,
        cachedInputPricePerMillionCny: 0,
        cacheWritePricePerMillionCny: 0,
        outputPricePerMillionCny: 0,
        markupMultiplier,
      };

      const upstreamCostCny = this.roundCurrency(Math.max(input.rawSpendCny, 0));
      return {
        provider: input.provider,
        model: input.model,
        upstreamCostCny,
        billableCostCny: this.roundCurrency(upstreamCostCny * markupMultiplier),
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

  private async buildLocalUsageSummary(
    userId: string,
    period: "today" | "7d" | "30d",
    workspaceId: string,
  ) {
    const items = await this.storeService.listUsageLedgerByUserIdAsync(userId);
    const localItems = items.filter((item) => this.isLocalUsageLedger(item));
    const periodStart = this.resolvePeriodStart(period);
    const filteredItems = localItems.filter((item) => {
      const finishedAt = Date.parse(item.finishedAt);
      return Number.isFinite(finishedAt) && finishedAt >= periodStart;
    });

    const topModels = new Map<string, { tokens: number; costCny: number }>();
    for (const item of filteredItems) {
      const current = topModels.get(item.model) ?? { tokens: 0, costCny: 0 };
      current.tokens += item.totalTokens;
      current.costCny = this.roundCurrency(current.costCny + item.billableCostCny);
      topModels.set(item.model, current);
    }

    return {
      workspaceId,
      userId,
      period,
      requestCount: filteredItems.length,
      totalTokens: filteredItems.reduce((sum, item) => sum + item.totalTokens, 0),
      totalCostCny: this.roundCurrency(filteredItems.reduce((sum, item) => sum + item.billableCostCny, 0)),
      topModels: Array.from(topModels.entries())
        .map(([model, value]) => ({
          model,
          tokens: value.tokens,
          costCny: value.costCny,
        }))
        .sort((left, right) => right.costCny - left.costCny)
        .slice(0, 5),
    };
  }

  private isLocalUsageLedger(item: { deploymentId?: string; metadata?: Record<string, unknown> | undefined }) {
    if (typeof item.deploymentId === "string" && item.deploymentId.startsWith("local:")) {
      return true;
    }

    return item.metadata?.client_scope === "local";
  }

  private resolvePeriodStart(period: "today" | "7d" | "30d") {
    const now = Date.now();
    if (period === "today") {
      return now - 24 * 60 * 60 * 1000;
    }
    if (period === "7d") {
      return now - 7 * 24 * 60 * 60 * 1000;
    }
    return now - 30 * 24 * 60 * 60 * 1000;
  }
}
