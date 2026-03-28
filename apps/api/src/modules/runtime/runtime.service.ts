import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { LiteLlmProxyService } from "../infrastructure/services/litellm-proxy.service";
import { StoreService } from "../store/store.service";
import { LocalGatewayCredentialRecord } from "../store/models";
import {
  buildGatewayModelLabel,
  normalizeGatewayModelId,
  resolveConfiguredGatewayModel,
  resolveConfiguredProviderId,
  resolveGatewayModelCatalog,
  resolveManagedGatewayVisibleModelIds,
  resolveManagedGatewayKeyModelIds,
} from "./gateway-model-catalog";

type RuntimePackageRecord = {
  platform: string;
  arch: string;
  openclawVersion: string;
  nodeVersion: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  generatedAt: string;
};

type RuntimeManifest = {
  generatedAt: string;
  packages: RuntimePackageRecord[];
};

const DEFAULT_RUNTIME_PUBLIC_BASE_URL =
  "https://xiaolanbu-runtime-prod.oss-cn-guangzhou.aliyuncs.com";

@Injectable()
export class RuntimeService {
  private readonly runtimeDistDir =
    process.env.XLB_RUNTIME_DIST_DIR ?? path.resolve(process.cwd(), "../../runtime-dist");

  private readonly runtimePublicBaseUrl = this.normalizeRuntimePublicBaseUrl(
    process.env.XLB_RUNTIME_PUBLIC_BASE_URL ?? DEFAULT_RUNTIME_PUBLIC_BASE_URL,
  );

  private readonly apiPublicBaseUrl =
    process.env.XLB_API_PUBLIC_BASE_URL ?? "http://127.0.0.1:3030/v1";

  constructor(
    private readonly storeService: StoreService,
    private readonly liteLlmProxyService: LiteLlmProxyService,
  ) {}

  getManifest(platform?: string) {
    const manifest = this.readManifest();
    const filteredPackages = platform
      ? manifest.packages.filter((item) => item.platform === platform)
      : manifest.packages;

    return {
      generatedAt: manifest.generatedAt,
      packages: filteredPackages.map((item) => ({
        ...item,
        downloadUrl: this.buildDownloadUrl(item.filename),
      })),
    };
  }

  getManifestHeaders() {
    const manifestPath = path.join(this.runtimeDistDir, "manifest.json");
    const lastModified = existsSync(manifestPath)
      ? statSync(manifestPath).mtime.toUTCString()
      : new Date(0).toUTCString();
    const etagSource = existsSync(manifestPath)
      ? readFileSync(manifestPath)
      : Buffer.from("empty-manifest", "utf8");

    return {
      etag: this.buildEtag(etagSource),
      lastModified,
      cacheControl: "public, max-age=60, stale-while-revalidate=300",
    };
  }

  getBootstrapPackagesForPlatform(platform: string) {
    const manifest = this.getManifest(platform);
    return manifest.packages.map((item) => ({
      arch: item.arch,
      downloadUrl: item.downloadUrl,
      sha256: item.sha256,
      filename: item.filename,
      openclawVersion: item.openclawVersion,
      nodeVersion: item.nodeVersion,
    }));
  }

  getGatewayModelCatalog() {
    return resolveGatewayModelCatalog().map((item) => ({
      id: item.id,
      label: buildGatewayModelLabel(item),
      upstreamModelId: item.upstreamModelId,
      isDefault: item.isDefault,
      providerId: item.providerId,
      baseUrl: item.baseUrl,
      profileId: item.profileId,
    }));
  }

  async bootstrapLocalCredential(input: {
    userId: string;
    accountScopeId?: string;
    platform?: string;
    localDeviceId?: string;
    localDeviceLabel?: string;
  }) {
    const resolvedAccountScopeId =
      input.accountScopeId?.trim() || (await this.storeService.getPreferredWorkspaceIdForUserAsync(input.userId));
    await this.storeService.assertUserHasWorkspaceAccessAsync(input.userId, resolvedAccountScopeId);

    const ownerUserId = input.userId;
    const baseUrl = this.liteLlmProxyService.getPublicBaseUrl()?.trim();
    const proxyBaseUrl = this.liteLlmProxyService.getProxyBaseUrl()?.trim();
    if (!baseUrl || !proxyBaseUrl) {
      throw new BadRequestException("当前网关未配置 LiteLLM 公网入口，暂时无法下发本地计费凭证。");
    }

    const defaultModelId = resolveConfiguredGatewayModel();
    const allowedModelIds = resolveManagedGatewayVisibleModelIds();
    const keyEntitlementModelIds = resolveManagedGatewayKeyModelIds();
    const providerId = resolveConfiguredProviderId(defaultModelId);
    await this.cleanupLegacyLocalDeployments(ownerUserId);
    const existing = await this.storeService.getLocalGatewayCredentialAsync(ownerUserId, resolvedAccountScopeId);
    const activeCredential = existing && existing.status !== "disabled" ? existing : null;
    const credential = await this.ensureLocalGatewayCredential({
      userId: ownerUserId,
      accountScopeId: resolvedAccountScopeId,
      providerId,
      baseUrl,
      defaultModelId,
      allowedModelIds,
      keyEntitlementModelIds,
      existing: activeCredential,
      localDeviceId: input.localDeviceId?.trim() || undefined,
      localDeviceLabel: input.localDeviceLabel?.trim() || undefined,
      platform: input.platform?.trim() || undefined,
    });

    const normalizedPlatform = input.platform === "win32" ? "win32" : "darwin";

    return {
      ownerUserId,
      accountScopeId: resolvedAccountScopeId,
      apiKey: credential.secretKey,
      baseUrl: credential.baseUrl,
      providerId: credential.providerId,
      defaultModelId: credential.defaultModelId,
      allowedModelIds: credential.allowedModelIds,
      modelCatalog: this.getGatewayModelCatalog(),
      runtimePackages: this.getBootstrapPackagesForPlatform(normalizedPlatform),
    };
  }

  getDownloadStream(filename: string) {
    const filePath = path.join(this.runtimeDistDir, path.basename(filename));
    if (!existsSync(filePath)) {
      throw new NotFoundException(`Runtime package ${filename} not found.`);
    }

    const stats = statSync(filePath);
    const raw = `${path.basename(filename)}:${stats.size}:${stats.mtimeMs}`;

    return {
      stream: createReadStream(filePath),
      filePath,
      sizeBytes: stats.size,
      lastModified: stats.mtime.toUTCString(),
      etag: this.buildEtag(Buffer.from(raw, "utf8")),
      cacheControl: "public, max-age=3600, immutable",
    };
  }

  private async ensureLocalGatewayCredential(input: {
    userId: string;
    accountScopeId: string;
    providerId: string;
    baseUrl: string;
    defaultModelId: string;
    allowedModelIds: string[];
    keyEntitlementModelIds: string[];
    existing: LocalGatewayCredentialRecord | null;
    localDeviceId?: string;
    localDeviceLabel?: string;
    platform?: string;
  }) {
    const existing = input.existing;
    if (!existing?.secretKey || !existing?.tokenId) {
      return this.createLocalGatewayCredential(input);
    }

    try {
      const wallet = await this.storeService.getWalletByUserIdAsync(input.userId);
      const currentInfo = await this.liteLlmProxyService.getVirtualKeyInfo(existing.secretKey);
      const currentSpend =
        typeof currentInfo.info.spend === "number" && Number.isFinite(currentInfo.info.spend)
          ? currentInfo.info.spend
          : 0;
      const targetBudget = Math.round((currentSpend + Math.max(wallet.balanceCny, 0)) * 1_000_000) / 1_000_000;
      const shouldBlock = wallet.balanceCny <= 0;
      await this.liteLlmProxyService.updateVirtualKey({
        key: existing.secretKey,
        maxBudget: targetBudget,
        blocked: shouldBlock,
        models: input.keyEntitlementModelIds,
      });

      const nextRecord: LocalGatewayCredentialRecord = {
        ...existing,
        baseUrl: input.baseUrl,
        providerId: input.providerId,
        defaultModelId: normalizeGatewayModelId(input.defaultModelId),
        allowedModelIds: [...input.allowedModelIds],
        status: "active",
        updatedAt: new Date().toISOString(),
        metadata: {
          ...(existing.metadata ?? {}),
          localDeviceId: input.localDeviceId,
          localDeviceLabel: input.localDeviceLabel,
          platform: input.platform,
          keyEntitlementModelIds: input.keyEntitlementModelIds,
        },
      };
      return this.storeService.upsertLocalGatewayCredential(nextRecord);
    } catch {
      return this.createLocalGatewayCredential(input, existing.secretKey);
    }
  }

  private async createLocalGatewayCredential(
    input: {
      userId: string;
      accountScopeId: string;
      providerId: string;
      baseUrl: string;
      defaultModelId: string;
      allowedModelIds: string[];
      keyEntitlementModelIds: string[];
      localDeviceId?: string;
      localDeviceLabel?: string;
      platform?: string;
    },
    previousSecretKey?: string,
  ) {
    const wallet = await this.storeService.getWalletByUserIdAsync(input.userId);
    const initialBudget = Math.round(Math.max(wallet.balanceCny, 0) * 1_000_000) / 1_000_000;
    const keyAlias = `local:${input.userId}:${input.accountScopeId}:${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const generated = await this.liteLlmProxyService.generateVirtualKey({
      models: input.keyEntitlementModelIds,
      maxBudget: initialBudget,
      keyAlias,
      metadata: {
        user_id: input.userId,
        workspace_id: input.accountScopeId,
        account_scope_id: input.accountScopeId,
        credential_scope: "local",
        local_device_id: input.localDeviceId,
        local_device_label: input.localDeviceLabel,
      },
    });

    if (wallet.balanceCny <= 0) {
      await this.liteLlmProxyService.updateVirtualKey({
        key: generated.key,
        maxBudget: initialBudget,
        blocked: true,
      });
    }

    if (previousSecretKey && previousSecretKey !== generated.key) {
      try {
        await this.liteLlmProxyService.updateVirtualKey({
          key: previousSecretKey,
          maxBudget: 0,
          blocked: true,
        });
      } catch {
        // Ignore stale local key cleanup failures.
      }
    }

    const now = new Date().toISOString();
    return this.storeService.upsertLocalGatewayCredential({
      id: `lgc_${input.userId}_${input.accountScopeId}`.replace(/[^a-zA-Z0-9:_-]+/g, "_"),
      userId: input.userId,
      accountScopeId: input.accountScopeId,
      tokenId: generated.token,
      secretKey: generated.key,
      baseUrl: input.baseUrl,
      providerId: input.providerId,
      defaultModelId: normalizeGatewayModelId(input.defaultModelId),
      allowedModelIds: [...input.allowedModelIds],
      status: "active",
      createdAt: now,
      updatedAt: now,
      metadata: {
        keyAlias: generated.keyAlias ?? keyAlias,
        keyName: generated.keyName,
        localDeviceId: input.localDeviceId,
        localDeviceLabel: input.localDeviceLabel,
        platform: input.platform,
        keyEntitlementModelIds: input.keyEntitlementModelIds,
      },
    });
  }

  private async cleanupLegacyLocalDeployments(userId: string) {
    const legacyLocalDeployments = (await this.storeService.listDeploymentsOwnedByUserAsync(userId)).filter(
      (item) => item.mode === "local",
    );

    for (const deployment of legacyLocalDeployments) {
      const gatewaySecret = deployment.gatewayKey?.secretKey?.trim();
      if (gatewaySecret) {
        try {
          await this.liteLlmProxyService.updateVirtualKey({
            key: gatewaySecret,
            maxBudget: 0,
            blocked: true,
          });
        } catch {
          // Ignore legacy key cleanup failures and keep moving.
        }
      }

      try {
        await this.storeService.deleteDeployment(deployment.id);
      } catch {
        // Ignore stale local deployment cleanup failures and keep moving.
      }
    }
  }

  private readManifest(): RuntimeManifest {
    const manifestPath = path.join(this.runtimeDistDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      return {
        generatedAt: new Date(0).toISOString(),
        packages: [],
      };
    }

    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
    return {
      generatedAt: raw.generatedAt ?? new Date(0).toISOString(),
      packages: Array.isArray(raw.packages) ? raw.packages : [],
    };
  }

  private buildDownloadUrl(filename: string) {
    if (this.runtimePublicBaseUrl) {
      return `${this.runtimePublicBaseUrl}/${encodeURIComponent(filename)}`;
    }

    return `${this.apiPublicBaseUrl.replace(/\/$/, "")}/runtime/download/${encodeURIComponent(filename)}`;
  }

  private normalizeRuntimePublicBaseUrl(value?: string) {
    const trimmed = value?.trim();
    if (!trimmed) {
      return null;
    }

    if (/\/manifest\.json$/i.test(trimmed)) {
      return trimmed.replace(/\/manifest\.json$/i, "");
    }

    return trimmed.replace(/\/$/, "");
  }

  private buildEtag(value: Buffer) {
    return `"${createHash("sha1").update(value).digest("hex")}"`;
  }
}
