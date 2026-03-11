export type DeploymentMode = "local" | "cloud";
export type DeploymentStatus = "creating" | "running" | "stopped" | "error";

export interface UserRecord {
  id: string;
  displayName: string;
  email: string;
  avatarInitial: string;
  activeWorkspaceId: string;
}

export interface AuthUserRecord extends UserRecord {
  passwordHash: string;
  createdAt: string;
}

export interface WorkspaceMembershipRecord {
  id: string;
  userId: string;
  workspaceId: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  token: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface WorkspaceRecord {
  id: string;
  ownerUserId: string;
  name: string;
  planName: string;
  status: "active" | "trial" | "suspended" | "archived";
}

export interface WorkspaceViewRecord extends WorkspaceRecord {
  role: "owner" | "member";
}

export interface WorkspaceMemberViewRecord {
  id: string;
  userId: string;
  workspaceId: string;
  role: "owner" | "member";
  createdAt: string;
  user: UserRecord;
}

export interface DeploymentAccessRecord {
  sshTunnel?: string;
  dashboardUrl?: string;
  tokenSource?: string;
  browserControlUrl?: string;
}

export interface DeploymentGatewayKeyRecord {
  tokenId: string;
  secretKey?: string;
  keyName?: string;
  keyAlias?: string | null;
  modelId: string;
  baseUrl: string;
}

export interface DeploymentRecord {
  id: string;
  workspaceId: string;
  name: string;
  mode: DeploymentMode;
  status: DeploymentStatus;
  provider: string;
  region: string;
  runtimeVersion: string;
  consoleUrl: string;
  gatewayUrl: string;
  createdAt: string;
  lastHeartbeatAt: string;
  publicIpAddress?: string[];
  privateIpAddress?: string[];
  zoneId?: string;
  vendorInstanceIds?: string[];
  access?: DeploymentAccessRecord;
  gatewayKey?: DeploymentGatewayKeyRecord;
  metadata?: Record<string, unknown>;
}

export interface WalletRecord {
  id: string;
  workspaceId: string;
  balanceCny: number;
  frozenCny: number;
  currency: "CNY";
}

export interface PriceSnapshotRecord {
  provider: string;
  model: string;
  pricingVersion: string;
  inputTier: "0-128k" | "128k-256k" | "256k-1m" | "unknown";
  inputPricePerMillionCny: number;
  cachedInputPricePerMillionCny: number;
  cacheWritePricePerMillionCny: number;
  outputPricePerMillionCny: number;
  markupMultiplier: number;
}

export interface UsageLedgerRecord {
  id: string;
  workspaceId: string;
  deploymentId: string;
  gatewayTokenId?: string;
  requestId: string;
  provider: string;
  model: string;
  status: "success" | "error";
  startedAt: string;
  finishedAt: string;
  requestDurationMs?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  upstreamCostCny: number;
  billableCostCny: number;
  rawSpendCny?: number;
  currency: "CNY";
  source: "litellm";
  priceSnapshot: PriceSnapshotRecord;
  metadata?: Record<string, unknown>;
}

export interface WalletTransactionRecord {
  id: string;
  walletId: string;
  workspaceId: string;
  type: "topup" | "usage" | "refund" | "adjustment";
  title: string;
  amountCny: number;
  balanceAfterCny: number;
  createdAt: string;
  referenceType?: "usage_ledger" | "manual" | "topup";
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageSummaryRecord {
  workspaceId: string;
  period: "today" | "7d" | "30d";
  requestCount: number;
  totalTokens: number;
  totalCostCny: number;
  topModels: Array<{
    model: string;
    tokens: number;
    costCny: number;
  }>;
}

export interface DeploymentUsageSummaryRecord {
  workspaceId: string;
  deploymentId: string;
  deploymentName: string;
  mode: DeploymentMode;
  provider: string;
  region: string;
  status: DeploymentStatus;
  period: "today" | "7d" | "30d";
  requestCount: number;
  totalTokens: number;
  totalCostCny: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  lastRequestAt?: string;
}

export interface BillingFeedRecord {
  id: string;
  workspaceId: string;
  kind: "topup" | "usage" | "adjustment";
  title: string;
  amountCny: number;
  createdAt: string;
}
