export type DeploymentMode = "local" | "cloud";
export type DeploymentStatus = "creating" | "running" | "stopped" | "error";

export interface UserRecord {
  id: string;
  displayName: string;
  email: string;
  avatarInitial: string;
}

export interface WorkspaceRecord {
  id: string;
  ownerUserId: string;
  name: string;
  planName: string;
  status: "active" | "trial" | "suspended";
}

export interface DeploymentAccessRecord {
  sshTunnel?: string;
  dashboardUrl?: string;
  tokenSource?: string;
  browserControlUrl?: string;
}

export interface DeploymentGatewayKeyRecord {
  tokenId: string;
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

export interface BillingFeedRecord {
  id: string;
  workspaceId: string;
  kind: "topup" | "usage" | "adjustment";
  title: string;
  amountCny: number;
  createdAt: string;
}
