import { Injectable, NotFoundException } from "@nestjs/common";

import {
  BillingFeedRecord,
  DeploymentAccessRecord,
  DeploymentGatewayKeyRecord,
  DeploymentRecord,
  DeploymentStatus,
  UsageLedgerRecord,
  UsageSummaryRecord,
  UserRecord,
  WalletRecord,
  WalletTransactionRecord,
  WorkspaceRecord,
} from "./models";

interface CreateDeploymentInput {
  id?: string;
  workspaceId: string;
  name: string;
  mode: "local" | "cloud";
  region?: string;
  provider?: string;
  consoleUrl?: string;
  gatewayUrl?: string;
  publicIpAddress?: string[];
  privateIpAddress?: string[];
  zoneId?: string;
  vendorInstanceIds?: string[];
  access?: DeploymentAccessRecord;
  gatewayKey?: DeploymentGatewayKeyRecord;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class StoreService {
  private readonly currentUser: UserRecord = {
    id: "user_001",
    displayName: "午松",
    email: "owner@xiaolanbu.app",
    avatarInitial: "午",
  };

  private readonly workspaces: WorkspaceRecord[] = [
    {
      id: "ws_main",
      ownerUserId: "user_001",
      name: "小懒布主工作区",
      planName: "陪跑版",
      status: "active",
    },
  ];

  private readonly deployments: DeploymentRecord[] = [
    {
      id: "dep_cloud_prod",
      workspaceId: "ws_main",
      name: "云端托管实例",
      mode: "cloud",
      status: "running",
      provider: "aliyun",
      region: "ap-southeast-1",
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl: "https://console.xiaolanbu.app/demo/cloud",
      gatewayUrl: "https://api.xiaolanbu.app/gateway/ws_main",
      createdAt: "2026-03-09T09:20:00.000Z",
      lastHeartbeatAt: "2026-03-09T12:08:00.000Z",
      access: {
        browserControlUrl: "https://console.xiaolanbu.app/demo/cloud/browser",
      },
    },
    {
      id: "dep_local_mac",
      workspaceId: "ws_main",
      name: "本地桌面实例",
      mode: "local",
      status: "running",
      provider: "local",
      region: "local-device",
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl: "http://127.0.0.1:18789",
      gatewayUrl: "http://127.0.0.1:3031",
      createdAt: "2026-03-08T14:10:00.000Z",
      lastHeartbeatAt: "2026-03-09T12:09:00.000Z",
      access: {
        dashboardUrl: "http://127.0.0.1:18789",
        browserControlUrl: "http://127.0.0.1:18791",
      },
    },
  ];

  private readonly wallets: WalletRecord[] = [
    {
      id: "wallet_main",
      workspaceId: "ws_main",
      balanceCny: 286.4,
      frozenCny: 0,
      currency: "CNY",
    },
  ];

  private readonly usageSummaries: UsageSummaryRecord[] = [
    {
      workspaceId: "ws_main",
      period: "today",
      requestCount: 142,
      totalTokens: 186420,
      totalCostCny: 18.72,
      topModels: [
        { model: "qwen-max", tokens: 80210, costCny: 8.2 },
        { model: "gpt-4.1-mini", tokens: 69500, costCny: 6.12 },
        { model: "claude-3.5-haiku", tokens: 36710, costCny: 4.4 },
      ],
    },
    {
      workspaceId: "ws_main",
      period: "30d",
      requestCount: 2861,
      totalTokens: 3429050,
      totalCostCny: 318.64,
      topModels: [
        { model: "qwen-max", tokens: 1380210, costCny: 128.2 },
        { model: "gpt-4.1-mini", tokens: 1239500, costCny: 106.84 },
        { model: "claude-3.5-haiku", tokens: 809340, costCny: 83.6 },
      ],
    },
  ];

  private readonly billingFeed: BillingFeedRecord[] = [
    {
      id: "bill_001",
      workspaceId: "ws_main",
      kind: "usage",
      title: "今日模型调用汇总",
      amountCny: -18.72,
      createdAt: "2026-03-09T12:00:00.000Z",
    },
    {
      id: "bill_002",
      workspaceId: "ws_main",
      kind: "topup",
      title: "余额充值",
      amountCny: 200,
      createdAt: "2026-03-08T18:20:00.000Z",
    },
    {
      id: "bill_003",
      workspaceId: "ws_main",
      kind: "usage",
      title: "昨日模型调用汇总",
      amountCny: -22.45,
      createdAt: "2026-03-08T12:00:00.000Z",
    },
  ];

  private readonly usageLedger: UsageLedgerRecord[] = [];

  private readonly walletTransactions: WalletTransactionRecord[] = [
    {
      id: "txn_001",
      walletId: "wallet_main",
      workspaceId: "ws_main",
      type: "topup",
      title: "余额充值",
      amountCny: 200,
      balanceAfterCny: 286.4,
      createdAt: "2026-03-08T18:20:00.000Z",
      referenceType: "topup",
      referenceId: "topup_001",
    },
  ];

  getCurrentUser() {
    return this.currentUser;
  }

  listWorkspaces() {
    return this.workspaces;
  }

  getWorkspace(workspaceId: string) {
    const workspace = this.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  listDeployments(workspaceId?: string) {
    if (!workspaceId) {
      return this.deployments;
    }
    this.getWorkspace(workspaceId);
    return this.deployments.filter((item) => item.workspaceId === workspaceId);
  }

  createDeployment(input: CreateDeploymentInput) {
    this.getWorkspace(input.workspaceId);

    const record: DeploymentRecord = {
      id: input.id ?? `dep_${Date.now()}`,
      workspaceId: input.workspaceId,
      name: input.name,
      mode: input.mode,
      status: input.mode === "cloud" ? "creating" : "running",
      provider: input.provider ?? (input.mode === "cloud" ? "aliyun" : "local"),
      region: input.region ?? (input.mode === "cloud" ? "cn-hangzhou" : "local-device"),
      runtimeVersion: "openclaw-0.9.2",
      consoleUrl:
        input.consoleUrl ??
        (input.mode === "cloud"
          ? `https://console.xiaolanbu.app/demo/${input.name}`
          : "http://127.0.0.1:18789"),
      gatewayUrl:
        input.gatewayUrl ??
        (input.mode === "cloud"
          ? `https://api.xiaolanbu.app/gateway/${input.workspaceId}`
          : "http://127.0.0.1:3031"),
      createdAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      publicIpAddress: input.publicIpAddress,
      privateIpAddress: input.privateIpAddress,
      zoneId: input.zoneId,
      vendorInstanceIds: input.vendorInstanceIds,
      access: input.access,
      gatewayKey: input.gatewayKey,
      metadata: input.metadata,
    };

    this.deployments.unshift(record);
    return record;
  }

  updateDeploymentStatus(deploymentId: string, status: DeploymentStatus) {
    const record = this.getDeployment(deploymentId);
    record.status = status;
    record.lastHeartbeatAt = new Date().toISOString();
    return record;
  }

  updateDeployment(deploymentId: string, patch: Partial<DeploymentRecord>) {
    const record = this.getDeployment(deploymentId);
    Object.assign(record, patch);
    record.lastHeartbeatAt = new Date().toISOString();
    return record;
  }

  getDeployment(deploymentId: string) {
    const record = this.deployments.find((item) => item.id === deploymentId);
    if (!record) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    return record;
  }

  getWallet(workspaceId: string) {
    this.getWorkspace(workspaceId);
    const wallet = this.wallets.find((item) => item.workspaceId === workspaceId);
    if (!wallet) {
      throw new NotFoundException(`Wallet for workspace ${workspaceId} not found`);
    }
    return wallet;
  }

  getUsageSummary(workspaceId: string, period: "today" | "7d" | "30d") {
    this.getWorkspace(workspaceId);
    const dynamicSummary = this.buildUsageSummaryFromLedger(workspaceId, period);
    if (dynamicSummary) {
      return dynamicSummary;
    }
    const summary =
      this.usageSummaries.find((item) => item.workspaceId === workspaceId && item.period === period) ??
      this.usageSummaries.find((item) => item.workspaceId === workspaceId && item.period === "today");
    if (!summary) {
      throw new NotFoundException(`Usage summary for workspace ${workspaceId} not found`);
    }
    return summary;
  }

  listBillingFeed(workspaceId: string) {
    this.getWorkspace(workspaceId);
    const transactionFeed = this.walletTransactions
      .filter((item) => item.workspaceId === workspaceId)
      .map<BillingFeedRecord>((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        kind:
          item.type === "topup" ? "topup" : item.type === "usage" ? "usage" : "adjustment",
        title: item.title,
        amountCny: item.amountCny,
        createdAt: item.createdAt,
      }));

    return [...this.billingFeed.filter((item) => item.workspaceId === workspaceId), ...transactionFeed].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    );
  }

  listUsageLedger(
    workspaceId: string,
    input?: {
      deploymentId?: string;
      limit?: number;
    },
  ) {
    this.getWorkspace(workspaceId);
    const items = this.usageLedger
      .filter((item) => item.workspaceId === workspaceId)
      .filter((item) => (input?.deploymentId ? item.deploymentId === input.deploymentId : true))
      .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));

    if (typeof input?.limit === "number" && input.limit > 0) {
      return items.slice(0, input.limit);
    }

    return items;
  }

  findUsageLedger(workspaceId: string, deploymentId: string, requestId: string) {
    return this.usageLedger.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.deploymentId === deploymentId &&
        item.requestId === requestId,
    );
  }

  createUsageLedger(input: Omit<UsageLedgerRecord, "id">) {
    const record: UsageLedgerRecord = {
      id: `ulg_${Date.now()}_${this.usageLedger.length + 1}`,
      ...input,
    };

    this.usageLedger.unshift(record);
    return record;
  }

  listWalletTransactions(workspaceId: string, limit = 50) {
    this.getWorkspace(workspaceId);
    return this.walletTransactions
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  createWalletTransaction(
    workspaceId: string,
    input: Omit<WalletTransactionRecord, "id" | "walletId" | "workspaceId" | "balanceAfterCny">,
  ) {
    const wallet = this.getWallet(workspaceId);
    wallet.balanceCny = this.roundCurrency(wallet.balanceCny + input.amountCny);

    const record: WalletTransactionRecord = {
      id: `wtx_${Date.now()}_${this.walletTransactions.length + 1}`,
      walletId: wallet.id,
      workspaceId,
      balanceAfterCny: wallet.balanceCny,
      ...input,
    };

    this.walletTransactions.unshift(record);
    return record;
  }

  findDeploymentByGatewayTokenId(workspaceId: string, tokenId: string) {
    return this.deployments.find(
      (item) => item.workspaceId === workspaceId && item.gatewayKey?.tokenId === tokenId,
    );
  }

  private buildUsageSummaryFromLedger(
    workspaceId: string,
    period: "today" | "7d" | "30d",
  ): UsageSummaryRecord | null {
    const now = Date.now();
    const periodStart =
      period === "today"
        ? now - 24 * 60 * 60 * 1000
        : period === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : now - 30 * 24 * 60 * 60 * 1000;

    const items = this.usageLedger.filter((item) => {
      if (item.workspaceId !== workspaceId) {
        return false;
      }
      const finishedAt = Date.parse(item.finishedAt);
      return Number.isFinite(finishedAt) && finishedAt >= periodStart;
    });

    if (items.length === 0) {
      return null;
    }

    const topModelsMap = new Map<string, { tokens: number; costCny: number }>();

    for (const item of items) {
      const entry = topModelsMap.get(item.model) ?? { tokens: 0, costCny: 0 };
      entry.tokens += item.totalTokens;
      entry.costCny = this.roundCurrency(entry.costCny + item.billableCostCny);
      topModelsMap.set(item.model, entry);
    }

    const topModels = [...topModelsMap.entries()]
      .map(([model, value]) => ({
        model,
        tokens: value.tokens,
        costCny: value.costCny,
      }))
      .sort((left, right) => right.costCny - left.costCny)
      .slice(0, 5);

    return {
      workspaceId,
      period,
      requestCount: items.length,
      totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
      totalCostCny: this.roundCurrency(items.reduce((sum, item) => sum + item.billableCostCny, 0)),
      topModels,
    };
  }

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }
}
