import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";

import { AliyunEcsService } from "../infrastructure/services/aliyun-ecs.service";
import { LiteLlmProxyService } from "../infrastructure/services/litellm-proxy.service";
import {
  DEPLOYMENT_CREATE_JOB,
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_LOCAL_BOOTSTRAP_JOB,
  DEPLOYMENT_REFRESH_NATIVE_RESPONSES_JOB,
  DEPLOYMENT_RESTART_JOB,
  DEPLOYMENT_START_JOB,
  DEPLOYMENT_STOP_JOB,
  DEPLOYMENT_UPDATE_STATUS_JOB,
} from "../queue/queue.constants";
import { QueueService } from "../queue/queue.service";
import { RuntimeService } from "../runtime/runtime.service";
import { PostgresStateService } from "../store/postgres-state.service";
import { DeploymentRecord } from "../store/models";
import { StoreService } from "../store/store.service";
import { CreateDeploymentDto } from "./dto/create-deployment.dto";
import { SyncLocalRuntimeDto } from "./dto/sync-local-runtime.dto";

type ResolvedCreateDeploymentDto = CreateDeploymentDto & {
  workspaceId: string;
};

type GatewayModelCatalogEntry = {
  id: string;
  upstreamModelId: string;
  label: string;
  isDefault: boolean;
  profileId: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
};

const DEFAULT_GATEWAY_MODEL_CATALOG = [
  {
    id: "gpt-5.2",
    upstreamModelId: "gpt-5.2",
    profileId: "aportal",
  },
  {
    id: "gpt-5.4",
    upstreamModelId: "gpt-5.4",
    profileId: "aportal",
  },
  {
    id: "gpt-4o",
    upstreamModelId: "gpt-4o",
    profileId: "aportal",
  },
  {
    id: "qwen35-plus",
    upstreamModelId: "qwen3.5-plus",
    profileId: "qwen",
  },
] as const;

type ResolvedDeploymentGatewayConfig = {
  apiKey: string;
  tokenId: string;
  keyName?: string;
  keyAlias?: string | null;
  baseUrl: string;
  modelId: string;
  providerId: string;
  managedByLiteLlm: boolean;
  keyScope?: "catalog";
  allowedModelIds?: string[];
};

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly storeService: StoreService,
    private readonly postgresStateService: PostgresStateService,
    private readonly queueService: QueueService,
    private readonly aliyunEcsService: AliyunEcsService,
    private readonly liteLlmProxyService: LiteLlmProxyService,
    private readonly runtimeService: RuntimeService,
  ) {}

  async listDeployments(workspaceId?: string) {
    return (await this.storeService.listDeploymentsAsync(workspaceId))
      .filter((item) => item.mode === "cloud")
      .map((item) => this.refreshDeploymentGatewayDefaults(item));
  }

  async listDeploymentsForUser(userId: string, workspaceId?: string) {
    return (await this.storeService.listDeploymentsForUserAsync(userId, workspaceId))
      .filter((item) => item.mode === "cloud")
      .map((item) => this.refreshDeploymentGatewayDefaults(item));
  }

  getGatewayModelCatalog() {
    return this.resolveGatewayModelCatalog().map((item) => ({
      id: item.id,
      label: this.buildGatewayModelLabel(item),
      upstreamModelId: item.upstreamModelId,
      isDefault: item.isDefault,
      providerId: item.providerId,
      baseUrl: item.baseUrl,
      profileId: item.profileId,
    }));
  }

  async createDeployment(body: ResolvedCreateDeploymentDto) {
    if (body.mode === "local") {
      throw new BadRequestException("本地 deployment 已废弃，请改用 /v1/runtime/local/bootstrap。");
    }

    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(
        DEPLOYMENT_CREATE_JOB,
        body as unknown as Record<string, unknown>,
      );
    }

    const deploymentId = this.createDeploymentId();
    return this.withDeploymentMutationLock(deploymentId, async () => {
      if (body.mode === "local") {
        return this.createLocalDeployment(body, deploymentId);
      }

      this.assertAliyunCloudInput(body);

      const instanceTypeCandidates = this.resolveInstanceTypeCandidates(body);
      const gatewayProvision =
        body.dryRun === true
          ? null
          : await this.resolveGatewayProvision({
              deploymentId,
              workspaceId: body.workspaceId,
              deploymentName: body.name,
              requestedModelId: body.openclawModelId,
            });

      let selectedInstanceType = instanceTypeCandidates[0];
      let vendorResult: Awaited<ReturnType<AliyunEcsService["runInstances"]>> | null = null;
      let lastProvisionError: unknown = null;
      const instanceTypeAttempts: Array<{
        instanceType: string;
        status: "success" | "error";
        requestId?: string;
        message?: string;
        retryable: boolean;
      }> = [];

      for (const instanceType of instanceTypeCandidates) {
        const diskCandidates = this.resolveDiskCandidates(body, instanceType);

        for (const diskCandidate of diskCandidates) {
          try {
            vendorResult = await this.aliyunEcsService.runInstances({
              regionId: body.region!,
              imageId: body.imageId!,
              instanceType,
              securityGroupId: body.securityGroupId!,
              vSwitchId: body.vSwitchId!,
              instanceName: body.name,
              amount: body.amount,
              dryRun: body.dryRun,
              password: body.password,
              userData: this.resolveUserData(body, gatewayProvision ?? undefined),
              systemDiskCategory: diskCandidate.systemDiskCategory,
              systemDiskSize: diskCandidate.systemDiskSize,
              internetMaxBandwidthOut: body.internetMaxBandwidthOut,
              tags: [
                { key: "product", value: "xiaolanbu" },
                { key: "workspace_id", value: body.workspaceId },
                ...(body.tags ?? []),
              ],
            });
            selectedInstanceType = instanceType;
            instanceTypeAttempts.push({
              instanceType: diskCandidate.attemptLabel,
              status: "success",
              requestId: vendorResult.requestId,
              retryable: false,
            });
            break;
          } catch (error) {
            lastProvisionError = error;
            const retryable = this.isRetryableInstanceTypeError(error);
            instanceTypeAttempts.push({
              instanceType: diskCandidate.attemptLabel,
              status: "error",
              message: this.describeProvisioningError(error),
              retryable,
            });
            if (!retryable) {
              throw this.buildProvisioningException(error, instanceTypeAttempts);
            }

            if (
              !this.isRetryableDiskCategoryError(error) ||
              !diskCandidate.usesExplicitSystemDiskCategory
            ) {
              break;
            }
          }
        }

        if (vendorResult) {
          break;
        }
      }

      if (!vendorResult) {
        throw this.buildProvisioningException(lastProvisionError, instanceTypeAttempts);
      }

      if (vendorResult.dryRunPassed) {
        return {
          deployment: null,
          vendor: vendorResult,
          wait: null,
        };
      }

      const deployment = await this.storeService.createDeployment({
        id: deploymentId,
        workspaceId: body.workspaceId,
        name: body.name,
        mode: body.mode,
        region: body.region,
        provider: "aliyun",
        vendorInstanceIds: vendorResult.instanceIds,
        gatewayKey: gatewayProvision
          ? {
              tokenId: gatewayProvision.tokenId,
              secretKey: gatewayProvision.apiKey,
              keyName: gatewayProvision.keyName,
              keyAlias: gatewayProvision.keyAlias,
              modelId: gatewayProvision.modelId,
              baseUrl: gatewayProvision.baseUrl,
            }
          : undefined,
        metadata: {
          dryRun: body.dryRun ?? false,
          requestId: vendorResult.requestId,
          orderId: vendorResult.orderId,
          tradePrice: vendorResult.tradePrice,
          imageId: body.imageId,
          instanceType: selectedInstanceType,
          instanceTypeCandidates,
          instanceTypeAttempts,
          gatewayTokenId: gatewayProvision?.tokenId,
          gatewayKeyName: gatewayProvision?.keyName,
          gatewayKeyAlias: gatewayProvision?.keyAlias,
          gatewayKeyScope: gatewayProvision ? "catalog" : undefined,
          gatewayAllowedModelIds: gatewayProvision ? this.resolveManagedGatewayKeyModelIds() : undefined,
        },
      });

      let waitResult: {
        success: boolean;
        statuses: Array<{ instanceId: string; status: string }>;
        waitedMs: number;
      } | null = null;
      let instanceDetails: Array<{
        instanceId: string;
        instanceName?: string;
        status?: string;
        zoneId?: string;
        publicIpAddress: string[];
        privateIpAddress: string[];
      }> = [];
      let access: {
        sshTunnel?: string;
        dashboardUrl?: string;
        tokenSource?: string;
        browserControlUrl?: string;
      } | null = null;

      if ((body.dryRun ?? false) === false && vendorResult.instanceIds.length > 0 && (body.waitForRunning ?? true)) {
        waitResult = await this.aliyunEcsService.waitForRunning({
          regionId: body.region!,
          instanceIds: vendorResult.instanceIds,
          timeoutMs: (body.waitTimeoutSeconds ?? 180) * 1000,
        });

        if (waitResult.success) {
          instanceDetails = await this.aliyunEcsService.describeInstances({
            regionId: body.region!,
            instanceIds: vendorResult.instanceIds,
          });

          const primaryDetail = instanceDetails[0];
          try {
            access = await this.resolveAccessInfo({
              regionId: body.region!,
              instanceId: primaryDetail?.instanceId ?? vendorResult.instanceIds[0],
              publicIpAddress: primaryDetail?.publicIpAddress ?? [],
              gatewayPort: body.openclawGatewayPort ?? 18789,
              gatewayBind: body.openclawGatewayBind ?? "loopback",
            });
          } catch (error) {
            access = {
              sshTunnel: primaryDetail?.publicIpAddress?.[0]
                ? `ssh -N -L ${body.openclawGatewayPort ?? 18789}:127.0.0.1:${body.openclawGatewayPort ?? 18789} root@${primaryDetail.publicIpAddress[0]}`
                : undefined,
              tokenSource: "/root/.openclaw/openclaw.json (gateway.auth.token)",
            };
          }

          await this.storeService.updateDeployment(deployment.id, {
            status: "running",
            publicIpAddress: primaryDetail?.publicIpAddress,
            privateIpAddress: primaryDetail?.privateIpAddress,
            zoneId: primaryDetail?.zoneId,
            access: access ?? undefined,
            metadata: {
              ...deployment.metadata,
            },
          });
        }
      }

      return {
        deployment: this.refreshDeploymentGatewayDefaults(
          waitResult?.success ? await this.storeService.getDeploymentAsync(deployment.id) : deployment,
        ),
        vendor: vendorResult,
        wait: waitResult,
      };
    });
  }

  async updateDeploymentStatus(
    deploymentId: string,
    status: "creating" | "running" | "stopped" | "error",
  ) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(DEPLOYMENT_UPDATE_STATUS_JOB, {
        deploymentId,
        status,
      });
    }

    return this.storeService.updateDeploymentStatus(deploymentId, status);
  }

  async startDeployment(deploymentId: string) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(DEPLOYMENT_START_JOB, { deploymentId });
    }

    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      return {
        deployment: this.refreshDeploymentGatewayDefaults(
          await this.storeService.updateDeploymentStatus(deploymentId, "running"),
        ),
        vendor: null,
        wait: null,
      };
    }

    const instanceId = this.requireVendorInstanceId(deployment);
    const vendor = await this.aliyunEcsService.startInstance({
      regionId: deployment.region,
      instanceId,
    });
    const wait = await this.aliyunEcsService.waitForStatus({
      regionId: deployment.region,
      instanceIds: [instanceId],
      expectedStatus: "Running",
      timeoutMs: 180000,
    });

    const [detail] = await this.aliyunEcsService.describeInstances({
      regionId: deployment.region,
      instanceIds: [instanceId],
    });

    return {
      deployment: this.refreshDeploymentGatewayDefaults(
        await this.storeService.updateDeployment(deploymentId, {
          status: wait.success ? "running" : deployment.status,
          publicIpAddress: detail?.publicIpAddress,
          privateIpAddress: detail?.privateIpAddress,
          zoneId: detail?.zoneId,
        }),
      ),
      vendor,
      wait,
    };
    });
  }

  async stopDeployment(deploymentId: string) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(DEPLOYMENT_STOP_JOB, { deploymentId });
    }

    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      return {
        deployment: this.refreshDeploymentGatewayDefaults(
          await this.storeService.updateDeploymentStatus(deploymentId, "stopped"),
        ),
        vendor: null,
        wait: null,
      };
    }

    const instanceId = this.requireVendorInstanceId(deployment);
    const vendor = await this.aliyunEcsService.stopInstance({
      regionId: deployment.region,
      instanceId,
      forceStop: true,
    });
    const wait = await this.aliyunEcsService.waitForStatus({
      regionId: deployment.region,
      instanceIds: [instanceId],
      expectedStatus: "Stopped",
      timeoutMs: 180000,
    });

    return {
      deployment: this.refreshDeploymentGatewayDefaults(
        await this.storeService.updateDeploymentStatus(
          deploymentId,
          wait.success ? "stopped" : deployment.status,
        ),
      ),
      vendor,
      wait,
    };
    });
  }

  async restartDeployment(deploymentId: string) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(DEPLOYMENT_RESTART_JOB, { deploymentId });
    }

    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      return {
        deployment: this.refreshDeploymentGatewayDefaults(
          await this.storeService.updateDeploymentStatus(deploymentId, "running"),
        ),
        vendor: null,
        wait: null,
      };
    }

    const instanceId = this.requireVendorInstanceId(deployment);
    const vendor = await this.aliyunEcsService.rebootInstance({
      regionId: deployment.region,
      instanceId,
      forceStop: true,
    });
    const wait = await this.aliyunEcsService.waitForStatus({
      regionId: deployment.region,
      instanceIds: [instanceId],
      expectedStatus: "Running",
      timeoutMs: 180000,
    });

    return {
      deployment: this.refreshDeploymentGatewayDefaults(
        await this.storeService.updateDeploymentStatus(
          deploymentId,
          wait.success ? "running" : deployment.status,
        ),
      ),
      vendor,
      wait,
    };
    });
  }

  async updateDeploymentModel(deploymentId: string, requestedModelId: string) {
    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
      const targetModel = this.resolveGatewayModelCatalogEntry(requestedModelId);
      const metadata =
        deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
      const currentModelId = this.normalizeGatewayModelId(
        deployment.gatewayKey?.modelId ||
          (typeof metadata.modelId === "string" ? metadata.modelId : undefined),
      );

      if (currentModelId === targetModel.id) {
        return {
          deployment:
            deployment.mode === "local"
              ? this.refreshLocalDeploymentBootstrap(this.refreshDeploymentGatewayDefaults(deployment))
              : this.refreshDeploymentGatewayDefaults(deployment),
        };
      }

      if (deployment.mode === "local") {
        const updatedDeployment = await this.updateLocalDeploymentModel(deployment, targetModel.id);
        return {
          deployment: this.refreshLocalDeploymentBootstrap(
            this.refreshDeploymentGatewayDefaults(updatedDeployment),
          ),
        };
      }

      if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
        throw new BadRequestException("当前实例暂不支持切换模型。");
      }

      if (deployment.status !== "running") {
        throw new BadRequestException("请先启动实例，再切换模型。");
      }

      const instanceId = this.resolveVendorInstanceId(deployment);
      if (!instanceId) {
        throw new BadRequestException(
          "这条历史云端实例记录缺少 ECS 实例 ID，暂时无法后台切换模型。",
        );
      }

      const nextGatewayConfig = await this.resolveDeploymentGatewayConfigForModel(deployment, targetModel.id);
      const assistantReady = await this.aliyunEcsService.waitForCloudAssistantReady({
        regionId: deployment.region,
        instanceIds: [instanceId],
        timeoutMs: 120000,
        intervalMs: 5000,
      });
      if (!assistantReady.success) {
        await this.cleanupUnusedGatewayConfig(nextGatewayConfig);
        throw new BadRequestException("云助手当前未就绪，暂时无法下发模型切换命令，请稍后再试。");
      }

      const gatewayPort = this.resolveDeploymentGatewayPort(deployment);
      const command = await this.aliyunEcsService.runCommand({
        regionId: deployment.region,
        instanceId,
        timeoutSeconds: 120,
        command: this.buildSwitchDeploymentModelCommand({
          gatewayPort,
          providerId: nextGatewayConfig.providerId,
          baseUrl: nextGatewayConfig.baseUrl,
          modelId: nextGatewayConfig.modelId,
          apiKey: nextGatewayConfig.apiKey,
          allowedModelIds: nextGatewayConfig.allowedModelIds,
        }),
      });

      if ((command.exitCode ?? 1) !== 0) {
        await this.cleanupUnusedGatewayConfig(nextGatewayConfig);
        const details = [command.errorInfo, command.output].filter(Boolean).join("\n").trim();
        throw new BadRequestException(
          details || "模型切换命令已下发，但远端 OpenClaw 网关没有成功重启。",
        );
      }

      const [detail] = await this.aliyunEcsService.describeInstances({
        regionId: deployment.region,
        instanceIds: [instanceId],
      });
      const access = await this.resolveAccessInfo({
        regionId: deployment.region,
        instanceId,
        publicIpAddress: detail?.publicIpAddress ?? deployment.publicIpAddress ?? [],
        gatewayPort,
        gatewayBind: this.resolveDeploymentGatewayBind(deployment),
      }).catch(() => deployment.access ?? null);

      const refreshedDeployment = await this.storeService.updateDeployment(deploymentId, {
        status: "running",
        gatewayUrl: nextGatewayConfig.baseUrl,
        publicIpAddress: detail?.publicIpAddress ?? deployment.publicIpAddress,
        privateIpAddress: detail?.privateIpAddress ?? deployment.privateIpAddress,
        zoneId: detail?.zoneId ?? deployment.zoneId,
        access: access ?? deployment.access,
        gatewayKey: {
          tokenId: nextGatewayConfig.tokenId,
          secretKey: nextGatewayConfig.apiKey,
          keyName: nextGatewayConfig.keyName,
          keyAlias: nextGatewayConfig.keyAlias,
          modelId: nextGatewayConfig.modelId,
          baseUrl: nextGatewayConfig.baseUrl,
        },
        metadata: this.buildGatewayMetadata(metadata, nextGatewayConfig),
      });

      await this.cleanupReplacedGatewayKey(deployment, nextGatewayConfig);

      return {
        deployment: this.refreshDeploymentGatewayDefaults(refreshedDeployment),
        command,
      };
    });
  }

  async refreshDeploymentNativeResponses(deploymentId: string) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(
        DEPLOYMENT_REFRESH_NATIVE_RESPONSES_JOB,
        { deploymentId },
      );
    }

    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      throw new BadRequestException("只有云端实例支持刷新为原生 responses 配置。");
    }
    if (deployment.status !== "running") {
      throw new BadRequestException("请先启动实例，再刷新原生 responses 配置。");
    }

    const instanceId = this.resolveVendorInstanceId(deployment);
    if (!instanceId) {
      throw new BadRequestException(
        "这条历史云端实例记录缺少 ECS 实例 ID，暂时无法后台自动刷新。请重新创建实例，或先补录实例信息后再试。",
      );
    }
    const assistantReady = await this.aliyunEcsService.waitForCloudAssistantReady({
      regionId: deployment.region,
      instanceIds: [instanceId],
      timeoutMs: 120000,
      intervalMs: 5000,
    });
    if (!assistantReady.success) {
      throw new BadRequestException("云助手当前未就绪，暂时无法下发修复命令，请稍后再试。");
    }

    const gatewayPort = this.resolveDeploymentGatewayPort(deployment);
    const command = await this.aliyunEcsService.runCommand({
      regionId: deployment.region,
      instanceId,
      timeoutSeconds: 90,
      command: this.buildRefreshNativeResponsesCommand(gatewayPort),
    });

    if ((command.exitCode ?? 1) !== 0) {
      const details = [command.errorInfo, command.output].filter(Boolean).join("\n").trim();
      throw new BadRequestException(
        details || "远程实例已收到修复命令，但网关重启失败，请检查实例日志后重试。",
      );
    }

    const [detail] = await this.aliyunEcsService.describeInstances({
      regionId: deployment.region,
      instanceIds: [instanceId],
    });
    const access = await this.resolveAccessInfo({
      regionId: deployment.region,
      instanceId,
      publicIpAddress: detail?.publicIpAddress ?? deployment.publicIpAddress ?? [],
      gatewayPort,
      gatewayBind: this.resolveDeploymentGatewayBind(deployment),
    }).catch(() => deployment.access ?? null);

    const refreshedDeployment = await this.storeService.updateDeployment(deploymentId, {
      status: "running",
      publicIpAddress: detail?.publicIpAddress ?? deployment.publicIpAddress,
      privateIpAddress: detail?.privateIpAddress ?? deployment.privateIpAddress,
      zoneId: detail?.zoneId ?? deployment.zoneId,
      access: access ?? deployment.access,
    });

    return {
      deployment: this.refreshDeploymentGatewayDefaults(refreshedDeployment),
      command,
    };
    });
  }

  async refreshNativeResponsesForDeployments(deploymentIds: string[]) {
    const ids = Array.from(
      new Set(
        (Array.isArray(deploymentIds) ? deploymentIds : [])
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean),
      ),
    );
    const items = [];

    for (const deploymentId of ids) {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
      if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
        items.push({
          deploymentId,
          name: deployment.name,
          status: "skipped",
          message: "仅支持云端 Aliyun 实例。",
        });
        continue;
      }
      if (deployment.status !== "running") {
        items.push({
          deploymentId,
          name: deployment.name,
          status: "skipped",
          message: "实例未运行，已跳过。",
        });
        continue;
      }
      if (!this.resolveVendorInstanceId(deployment)) {
        items.push({
          deploymentId,
          name: deployment.name,
          status: "skipped",
          message: "历史实例记录缺少 ECS 实例 ID，暂时无法后台自动刷新。",
        });
        continue;
      }

      try {
        const result = (await this.refreshDeploymentNativeResponses(deploymentId)) as {
          deployment: DeploymentRecord;
        };
        items.push({
          deploymentId,
          name: result.deployment.name,
          status: "refreshed",
          message: "已切换到原生 responses 入口并重启网关。",
        });
      } catch (error) {
        items.push({
          deploymentId,
          name: deployment.name,
          status: "failed",
          message: error instanceof Error ? error.message : "刷新失败。",
        });
      }
    }

    return {
      items,
      refreshed: items.filter((item) => item.status === "refreshed").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length,
    };
  }

  async destroyDeployment(deploymentId: string) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(DEPLOYMENT_DESTROY_JOB, { deploymentId });
    }

    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);

    if (deployment.gatewayKey?.secretKey) {
      await this.liteLlmProxyService.updateVirtualKey({
        key: deployment.gatewayKey.secretKey,
        blocked: true,
        maxBudget: 0,
      });
    }

    let vendor: { requestId: string; instanceId: string } | null = null;

    if (deployment.mode === "cloud" && deployment.provider === "aliyun") {
      const instanceId = this.requireVendorInstanceId(deployment);
      vendor = await this.aliyunEcsService.deleteInstance({
        regionId: deployment.region,
        instanceId,
        force: true,
      });
    }

    return {
      deployment: await this.storeService.deleteDeployment(deploymentId),
      vendor,
    };
    });
  }

  private async createLocalDeployment(body: ResolvedCreateDeploymentDto, deploymentId: string) {
    const existingLocalDeployments = (await this.storeService.listDeploymentsAsync(body.workspaceId))
      .filter((item) => item.mode === "local");
    const requestedLocalDeviceId = this.normalizeLocalDeviceId(body.localDeviceId);
    const requestedLocalDeviceLabel = this.normalizeLocalDeviceLabel(body.localDeviceLabel);
    const sameDeviceLocalDeployments = existingLocalDeployments.filter((item) => {
      const deploymentDeviceId = this.getLocalDeploymentDeviceId(item);
      if (requestedLocalDeviceId) {
        return deploymentDeviceId === requestedLocalDeviceId;
      }
      return !deploymentDeviceId;
    });
    const preferredExistingLocalDeployment =
      this.selectPreferredLocalDeployment(sameDeviceLocalDeployments);

    if (preferredExistingLocalDeployment) {
      const duplicateLocalDeployments = sameDeviceLocalDeployments.filter(
        (item) => item.id !== preferredExistingLocalDeployment.id,
      );
      if (duplicateLocalDeployments.length > 0) {
        await Promise.all(
          duplicateLocalDeployments.map((item) =>
            this.storeService.deleteDeployment(item.id).catch(() => null),
          ),
        );
      }

      const refreshedDeployment = await this.ensureLocalDeploymentGatewayKey(
        this.refreshDeploymentGatewayDefaults(
          this.refreshLocalDeploymentBootstrap(preferredExistingLocalDeployment),
        ),
      );
      const refreshedGatewayKey = refreshedDeployment.gatewayKey;

      if (!refreshedGatewayKey?.secretKey || !refreshedGatewayKey.baseUrl) {
        throw new BadRequestException("当前本地 deployment 缺少可用网关密钥，请重新一键部署。");
      }

      const responseDeployment = this.refreshLocalDeploymentBootstrap(refreshedDeployment);

      return {
        deployment: responseDeployment,
        vendor: null,
        wait: null,
        bootstrap: this.buildLocalBootstrapPayload(responseDeployment),
      };
    }

    const targetPlatform = this.normalizeLocalPlatform(body.platform);
    const localRequestedModelId =
      body.openclawModelId?.trim() ||
      process.env.XLB_LOCAL_GATEWAY_MODEL?.trim() ||
      process.env.XLB_GATEWAY_MODEL?.trim() ||
      process.env.XLB_LOCAL_MODEL?.trim() ||
      process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() ||
      "gpt-5.2";
    const liteLlmProvision = await this.resolveGatewayProvision({
      deploymentId,
      workspaceId: body.workspaceId,
      deploymentName: body.name,
      requestedModelId: localRequestedModelId,
    });
    const gatewayProvision = this.resolveLocalProvision(body, deploymentId, liteLlmProvision);

    const gatewayPort = body.openclawGatewayPort ?? 18789;
    const gatewayBind = body.openclawGatewayBind ?? "loopback";
    const browserControlPort = gatewayPort + 2;
    const gatewayToken = randomBytes(24).toString("hex");
    const dashboardUrl = `http://127.0.0.1:${gatewayPort}/#token=${gatewayToken}`;
    const browserControlUrl = `http://127.0.0.1:${browserControlPort}/`;
    const tokenSource = "desktop-local-bootstrap (gateway.auth.token)";
    const logPath =
      targetPlatform === "win32"
        ? "%LOCALAPPDATA%\\Xiaolanbu\\logs\\local-bootstrap.log"
        : "~/Library/Logs/Xiaolanbu/local-bootstrap.log";
    const runtimePackages = this.runtimeService.getBootstrapPackagesForPlatform(targetPlatform);
    const gatewayTunnel =
      targetPlatform === "darwin"
        ? this.resolveLocalGatewayTunnel(gatewayProvision.baseUrl)
        : undefined;

    const deployment = await this.storeService.createDeployment({
      id: deploymentId,
      workspaceId: body.workspaceId,
      name: body.name,
      mode: "local",
      status: "creating",
      provider: "local",
      region: "local-device",
      consoleUrl: dashboardUrl,
      gatewayUrl: gatewayProvision.baseUrl,
      access: {
        dashboardUrl,
        browserControlUrl,
        tokenSource,
      },
      gatewayKey: {
        tokenId: gatewayProvision.tokenId,
        secretKey: gatewayProvision.apiKey,
        keyName: gatewayProvision.keyName,
        keyAlias: gatewayProvision.keyAlias,
        modelId: body.openclawModelId ?? gatewayProvision.modelId,
        baseUrl: body.openclawBaseUrl ?? gatewayProvision.baseUrl,
      },
      metadata: {
        dryRun: body.dryRun ?? false,
        providerId: gatewayProvision.providerId,
        baseUrl: gatewayProvision.baseUrl,
        modelId: gatewayProvision.modelId,
        gatewayPort,
        gatewayBind,
        browserControlPort,
        gatewayToken,
        logPath,
        platform: targetPlatform,
        runtimePackages,
        gatewayTunnel,
        localDeviceId: requestedLocalDeviceId || undefined,
        localDeviceLabel: requestedLocalDeviceLabel || undefined,
        gatewayTokenId: gatewayProvision.tokenId,
        gatewayKeyName: gatewayProvision.keyName,
        gatewayKeyAlias: gatewayProvision.keyAlias,
        gatewayKeyScope: gatewayProvision.managedByLiteLlm ? "catalog" : undefined,
        gatewayAllowedModelIds: gatewayProvision.managedByLiteLlm
          ? gatewayProvision.allowedModelIds ?? this.resolveManagedGatewayKeyModelIds()
          : undefined,
      },
    });

    const responseDeployment = this.refreshLocalDeploymentBootstrap(deployment);

    return {
      deployment: responseDeployment,
      vendor: null,
      wait: null,
      bootstrap: this.buildLocalBootstrapPayload(responseDeployment),
    };
  }

  async syncLocalRuntimeState(deploymentId: string, body: SyncLocalRuntimeDto) {
    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
      if (deployment.mode !== "local") {
        throw new BadRequestException("只有本地 deployment 支持同步运行时状态。");
      }

      const metadata =
        deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
      const existingRuntime =
        metadata.localRuntime && typeof metadata.localRuntime === "object"
          ? (metadata.localRuntime as Record<string, unknown>)
          : {};

      const deviceId = this.normalizeLocalDeviceId(body.deviceId) || this.getLocalDeploymentDeviceId(deployment);
      if (!deviceId) {
        throw new BadRequestException("local runtime sync 缺少 deviceId。");
      }

      const deviceLabel =
        this.normalizeLocalDeviceLabel(body.deviceLabel) ||
        this.getLocalDeploymentDeviceLabel(deployment) ||
        (typeof existingRuntime.deviceLabel === "string" ? existingRuntime.deviceLabel.trim() : "");
      const platform = this.normalizeLocalPlatform(
        typeof body.platform === "string" && body.platform.trim()
          ? body.platform
          : typeof metadata.platform === "string"
            ? metadata.platform
            : undefined,
      );
      const lastSyncedAt = new Date().toISOString();
      const localRuntime = {
        deviceId,
        deviceLabel,
        platform,
        installed: body.installed === true,
        ready: body.ready === true,
        dashboardPortOpen: body.dashboardPortOpen === true,
        browserControlPortOpen: body.browserControlPortOpen === true,
        localApiKeyConfigured: body.localApiKeyConfigured === true,
        currentModelId:
          typeof body.currentModelId === "string" && body.currentModelId.trim()
            ? this.normalizeGatewayModelId(body.currentModelId)
            : typeof existingRuntime.currentModelId === "string"
              ? String(existingRuntime.currentModelId).trim()
              : "",
        ownerAccountScopeId:
          typeof body.ownerAccountScopeId === "string" ? body.ownerAccountScopeId.trim() : "",
        ownerUserId: typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : "",
        ownerDisplayName:
          typeof body.ownerDisplayName === "string" ? body.ownerDisplayName.trim() : "",
        ownerEmail: typeof body.ownerEmail === "string" ? body.ownerEmail.trim() : "",
        workspaceId:
          typeof body.workspaceId === "string" && body.workspaceId.trim()
            ? body.workspaceId.trim()
            : deployment.workspaceId,
        deploymentId:
          typeof body.deploymentId === "string" && body.deploymentId.trim()
            ? body.deploymentId.trim()
            : deployment.id,
        authSyncedAt:
          typeof body.authSyncedAt === "string" && body.authSyncedAt.trim()
            ? body.authSyncedAt.trim()
            : typeof existingRuntime.authSyncedAt === "string"
              ? existingRuntime.authSyncedAt
              : "",
        bindingUpdatedAt:
          typeof body.bindingUpdatedAt === "string" && body.bindingUpdatedAt.trim()
            ? body.bindingUpdatedAt.trim()
            : typeof existingRuntime.bindingUpdatedAt === "string"
              ? existingRuntime.bindingUpdatedAt
              : "",
        bootstrapStage:
          typeof body.bootstrapStage === "string" ? body.bootstrapStage.trim() : "",
        bootstrapMessage:
          typeof body.bootstrapMessage === "string" ? body.bootstrapMessage.trim() : "",
        bootstrapLastLine:
          typeof body.bootstrapLastLine === "string" ? body.bootstrapLastLine.trim() : "",
        bootstrapProgressPercent:
          typeof body.bootstrapProgressPercent === "number"
            ? body.bootstrapProgressPercent
            : null,
        logPath: typeof body.logPath === "string" ? body.logPath.trim() : "",
        error: typeof body.error === "string" ? body.error.trim() : "",
        lastSyncedAt,
      };

      const nextStatus = this.resolveLocalDeploymentStatusFromRuntime(localRuntime, deployment.status);
      const updatedDeployment = await this.storeService.updateDeployment(deploymentId, {
        status: nextStatus,
        metadata: {
          ...metadata,
          platform,
          localDeviceId: deviceId,
          localDeviceLabel: deviceLabel || undefined,
          localRuntime,
        },
      });
      const responseDeployment = this.refreshLocalDeploymentBootstrap(
        this.refreshDeploymentGatewayDefaults(updatedDeployment),
      );

      return {
        deployment: responseDeployment,
      };
    });
  }

  async getLocalDeploymentBootstrap(deploymentId: string) {
    if (this.shouldQueueDeploymentJobs()) {
      return this.queueService.enqueueDeploymentJobAndWait(DEPLOYMENT_LOCAL_BOOTSTRAP_JOB, {
        deploymentId,
      });
    }

    return this.withDeploymentMutationLock(deploymentId, async () => {
      const deployment = await this.storeService.getDeploymentAsync(deploymentId);
    if (deployment.mode !== "local") {
      throw new BadRequestException("只有本地 deployment 支持重新生成 bootstrap。");
    }

    const refreshedDeployment = await this.ensureLocalDeploymentGatewayKey(
      this.refreshDeploymentGatewayDefaults(this.refreshLocalDeploymentBootstrap(deployment)),
    );
    const responseDeployment = this.refreshLocalDeploymentBootstrap(refreshedDeployment);
    if (!responseDeployment.gatewayKey?.secretKey || !responseDeployment.gatewayKey.baseUrl) {
      throw new BadRequestException("当前本地 deployment 缺少可用网关密钥，请重新一键部署。");
    }

    return {
      deployment: responseDeployment,
      bootstrap: this.buildLocalBootstrapPayload(responseDeployment),
    };
    });
  }

  private assertAliyunCloudInput(body: CreateDeploymentDto) {
    const missing = [
      ["region", body.region],
      ["imageId", body.imageId],
      ["instanceType", body.instanceType || body.instanceTypes?.[0]],
      ["securityGroupId", body.securityGroupId],
      ["vSwitchId", body.vSwitchId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new BadRequestException(
        `Aliyun cloud deployment is missing required fields: ${missing.join(", ")}`,
      );
    }
  }

  private requireVendorInstanceId(deployment: { id: string; vendorInstanceIds?: string[] }) {
    const instanceId = this.resolveVendorInstanceId(deployment);
    if (!instanceId) {
      throw new BadRequestException(`Deployment ${deployment.id} is missing vendor instance id.`);
    }
    return instanceId;
  }

  private resolveVendorInstanceId(
    deployment: { vendorInstanceIds?: string[]; metadata?: unknown } | null | undefined,
  ) {
    const directInstanceId = deployment?.vendorInstanceIds?.find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (directInstanceId) {
      return directInstanceId.trim();
    }

    const metadata =
      deployment?.metadata && typeof deployment.metadata === "object"
        ? (deployment.metadata as Record<string, unknown>)
        : null;
    const metadataInstanceId = typeof metadata?.instanceId === "string" ? metadata.instanceId.trim() : "";
    if (metadataInstanceId) {
      return metadataInstanceId;
    }

    return "";
  }

  private resolveDeploymentGatewayPort(deployment: DeploymentRecord) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const rawPort = Number(metadata.gatewayPort ?? 18789);
    return Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 18789;
  }

  private resolveDeploymentGatewayBind(deployment: DeploymentRecord) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    return typeof metadata.gatewayBind === "string" && metadata.gatewayBind.trim()
      ? metadata.gatewayBind.trim()
      : "loopback";
  }

  private resolveGatewayModelCatalogEntry(modelId?: string | null) {
    const normalizedModelId = this.normalizeGatewayModelId(modelId);
    const entry = this.resolveGatewayModelCatalog().find((item) => item.id === normalizedModelId);

    if (!entry) {
      throw new BadRequestException(`当前后端没有配置模型 ${normalizedModelId}。`);
    }

    return entry;
  }

  private async resolveDeploymentGatewayConfigForModel(
    deployment: DeploymentRecord,
    requestedModelId: string,
  ): Promise<ResolvedDeploymentGatewayConfig> {
    const reusableManagedGatewayConfig = this.resolveReusableManagedGatewayConfigForModel(
      deployment,
      requestedModelId,
    );

    if (reusableManagedGatewayConfig) {
      return reusableManagedGatewayConfig;
    }

    const managedGatewayConfig = await this.resolveGatewayProvision({
      deploymentId: deployment.id,
      workspaceId: deployment.workspaceId,
      ownerUserId: deployment.ownerUserId,
      deploymentName: deployment.name,
      requestedModelId,
    });

    if (managedGatewayConfig) {
      return {
        ...managedGatewayConfig,
        managedByLiteLlm: true,
        keyScope: "catalog",
        allowedModelIds: this.resolveManagedGatewayKeyModelIds(),
      };
    }

    const modelEntry = this.resolveGatewayModelCatalogEntry(requestedModelId);
    const apiKey = this.resolveConfiguredOpenAiApiKey(requestedModelId);
    if (!apiKey) {
      throw new BadRequestException(`模型 ${requestedModelId} 缺少可用的 API Key 配置。`);
    }

    return {
      apiKey,
      tokenId: `direct:${deployment.id}:${requestedModelId}`,
      keyName: "openai-compatible-direct",
      keyAlias: `direct:${deployment.id}`,
      baseUrl: modelEntry.baseUrl,
      modelId: modelEntry.id,
      providerId: modelEntry.providerId,
      managedByLiteLlm: false,
    };
  }

  private resolveReusableManagedGatewayConfigForModel(
    deployment: DeploymentRecord,
    requestedModelId: string,
  ): ResolvedDeploymentGatewayConfig | null {
    const secretKey = deployment.gatewayKey?.secretKey?.trim() ?? "";
    const tokenId = deployment.gatewayKey?.tokenId?.trim() ?? "";
    if (!secretKey || !tokenId) {
      return null;
    }

    if (tokenId.startsWith("direct:") || tokenId.startsWith("local-direct:")) {
      return null;
    }

    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const allowedModelIds = this.resolveDeploymentGatewayAllowedModelIds(metadata);
    const keyScope =
      typeof metadata.gatewayKeyScope === "string" ? metadata.gatewayKeyScope.trim().toLowerCase() : "";
    const currentCatalogModelIds = this.resolveManagedGatewayKeyModelIds();
    const keyCoversRequestedModel =
      keyScope === "catalog"
        ? currentCatalogModelIds.includes(requestedModelId)
        : allowedModelIds.length > 0
          ? allowedModelIds.includes(requestedModelId)
          : false;

    if (!keyCoversRequestedModel) {
      return null;
    }

    const modelEntry = this.resolveGatewayModelCatalogEntry(requestedModelId);
    const managedGatewayBaseUrl =
      this.liteLlmProxyService.getPublicBaseUrl()?.trim() ||
      deployment.gatewayKey?.baseUrl?.trim() ||
      deployment.gatewayUrl?.trim() ||
      (typeof metadata.baseUrl === "string" ? metadata.baseUrl.trim() : "");
    if (!managedGatewayBaseUrl) {
      return null;
    }

    return {
      apiKey: secretKey,
      tokenId,
      keyName: deployment.gatewayKey?.keyName,
      keyAlias: deployment.gatewayKey?.keyAlias,
      baseUrl: managedGatewayBaseUrl,
      modelId: modelEntry.id,
      providerId: modelEntry.providerId,
      managedByLiteLlm: true,
      keyScope: "catalog",
      allowedModelIds: currentCatalogModelIds,
    };
  }

  private resolveDeploymentGatewayAllowedModelIds(
    metadata: Record<string, unknown> | object | null | undefined,
  ) {
    const normalizedMetadata =
      metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
    const items = Array.isArray(normalizedMetadata.gatewayAllowedModelIds)
      ? normalizedMetadata.gatewayAllowedModelIds
      : [];
    const normalized = Array.from(
      new Set(
        items
          .map((item) => (typeof item === "string" ? this.normalizeGatewayModelId(item) : ""))
          .filter(Boolean),
      ),
    );
    return normalized;
  }

  private buildGatewayMetadata(
    metadata: Record<string, unknown> | object | null | undefined,
    config: ResolvedDeploymentGatewayConfig,
  ) {
    const currentMetadata =
      metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
    const nextMetadata: Record<string, unknown> = {
      ...currentMetadata,
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      gatewayTokenId: config.tokenId,
      gatewayKeyName: config.keyName,
      gatewayKeyAlias: config.keyAlias,
    };

    if (config.managedByLiteLlm) {
      const allowedModelIds =
        Array.isArray(config.allowedModelIds) && config.allowedModelIds.length > 0
          ? config.allowedModelIds
          : this.resolveManagedGatewayKeyModelIds();
      nextMetadata.gatewayKeyScope = config.keyScope ?? "catalog";
      nextMetadata.gatewayAllowedModelIds = [...allowedModelIds];
    } else {
      delete nextMetadata.gatewayKeyScope;
      delete nextMetadata.gatewayAllowedModelIds;
    }

    return nextMetadata;
  }

  private async cleanupUnusedGatewayConfig(input: {
    apiKey: string;
    managedByLiteLlm: boolean;
  }) {
    if (!input.managedByLiteLlm || !input.apiKey) {
      return;
    }

    try {
      await this.liteLlmProxyService.updateVirtualKey({
        key: input.apiKey,
        blocked: true,
        maxBudget: 0,
      });
    } catch {
      // Best-effort cleanup for a freshly provisioned but unused key.
    }
  }

  private async cleanupReplacedGatewayKey(
    previousDeployment: DeploymentRecord,
    nextGatewayConfig: {
      apiKey: string;
    },
  ) {
    const previousKey = previousDeployment.gatewayKey?.secretKey?.trim();
    const previousTokenId = previousDeployment.gatewayKey?.tokenId?.trim() ?? "";
    if (!previousKey || previousKey === nextGatewayConfig.apiKey) {
      return;
    }

    if (previousTokenId.startsWith("direct:") || previousTokenId.startsWith("local-direct:")) {
      return;
    }

    try {
      await this.liteLlmProxyService.updateVirtualKey({
        key: previousKey,
        blocked: true,
        maxBudget: 0,
      });
    } catch {
      // Ignore stale-key cleanup failures and keep the switched deployment usable.
    }
  }

  private async updateLocalDeploymentModel(deployment: DeploymentRecord, requestedModelId: string) {
    const nextGatewayConfig = await this.resolveDeploymentGatewayConfigForModel(
      deployment,
      requestedModelId,
    );
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const updatedDeployment = await this.storeService.updateDeployment(deployment.id, {
      gatewayUrl: nextGatewayConfig.baseUrl,
      gatewayKey: {
        tokenId: nextGatewayConfig.tokenId,
        secretKey: nextGatewayConfig.apiKey,
        keyName: nextGatewayConfig.keyName,
        keyAlias: nextGatewayConfig.keyAlias,
        modelId: nextGatewayConfig.modelId,
        baseUrl: nextGatewayConfig.baseUrl,
      },
      metadata: this.buildGatewayMetadata(metadata, nextGatewayConfig),
    });

    await this.cleanupReplacedGatewayKey(deployment, nextGatewayConfig);
    return updatedDeployment;
  }

  private buildRefreshNativeResponsesCommand(gatewayPort: number) {
    return [
      "#!/bin/bash",
      "set -euo pipefail",
      "export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
      "export HOME=/root",
      "export USER=root",
      "export LOGNAME=root",
      "export XDG_RUNTIME_DIR=/run/user/0",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus",
      "",
      "python3 - <<'PY'",
      "import json",
      "from pathlib import Path",
      "config_path = Path('/root/.openclaw/openclaw.json')",
      "if not config_path.exists():",
      "    raise SystemExit('openclaw.json not found')",
      "config = json.loads(config_path.read_text())",
      "gateway = config.get('gateway') if isinstance(config.get('gateway'), dict) else {}",
      "http = gateway.get('http') if isinstance(gateway.get('http'), dict) else {}",
      "endpoints = http.get('endpoints') if isinstance(http.get('endpoints'), dict) else {}",
      "responses = endpoints.get('responses') if isinstance(endpoints.get('responses'), dict) else {}",
      "responses['enabled'] = True",
      "endpoints['responses'] = responses",
      "http['endpoints'] = endpoints",
      "gateway['http'] = http",
      "config['gateway'] = gateway",
      "config_path.write_text(json.dumps(config, indent=2) + '\\n')",
      "print('responses.enabled=true')",
      "PY",
      "",
      "loginctl enable-linger root >/dev/null 2>&1 || true",
      "mkdir -p \"$XDG_RUNTIME_DIR\"",
      "chmod 700 \"$XDG_RUNTIME_DIR\" || true",
      "systemctl start user@0.service >/dev/null 2>&1 || true",
      "",
      "restarted=0",
      "if command -v openclaw >/dev/null 2>&1; then",
      "  if openclaw gateway restart >/tmp/xiaolanbu-gateway-refresh.log 2>&1; then",
      "    restarted=1",
      "  fi",
      "fi",
      "if [ \"$restarted\" -ne 1 ]; then",
      "  systemctl --user daemon-reload >/dev/null 2>&1 || true",
      "  if systemctl --user restart openclaw-gateway.service >/tmp/xiaolanbu-gateway-refresh.log 2>&1; then",
      "    restarted=1",
      "  fi",
      "fi",
      "if [ \"$restarted\" -ne 1 ]; then",
      "  service_path=\"/root/.config/systemd/user/openclaw-gateway.service\"",
      "  exec_start=\"\"",
      "  if [ -f \"$service_path\" ]; then",
      "    exec_start=$(awk -F= '/^ExecStart=/{print substr($0, 11); exit}' \"$service_path\")",
      "  fi",
      "  if [ -n \"$exec_start\" ]; then",
      "    pkill -f \"openclaw gateway\" >/dev/null 2>&1 || true",
      "    nohup bash -lc \"$exec_start\" >/var/log/openclaw-gateway.log 2>&1 &",
      "    restarted=1",
      "  fi",
      "fi",
      "if [ \"$restarted\" -ne 1 ]; then",
      "  cat /tmp/xiaolanbu-gateway-refresh.log 2>/dev/null || true",
      "  exit 1",
      "fi",
      "",
      "for _ in $(seq 1 20); do",
      `  if ss -lntp | grep -q ':${gatewayPort} '; then`,
      `    echo 'gateway listening on ${gatewayPort}'`,
      "    exit 0",
      "  fi",
      "  sleep 2",
      "done",
      "systemctl --user --no-pager --full status openclaw-gateway.service || true",
      "tail -n 100 /var/log/openclaw-gateway.log || true",
      `echo 'gateway port ${gatewayPort} did not come back'`,
      "exit 1",
      "",
    ].join("\n");
  }

  private buildSwitchDeploymentModelCommand(input: {
    gatewayPort: number;
    providerId: string;
    baseUrl: string;
    modelId: string;
    apiKey: string;
    allowedModelIds?: string[];
  }) {
    return [
      "#!/bin/bash",
      "set -euo pipefail",
      "export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
      "export HOME=/root",
      "export USER=root",
      "export LOGNAME=root",
      "export XDG_RUNTIME_DIR=/run/user/0",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus",
      `export OPENCLAW_API_KEY='${this.escapeSingleQuoted(input.apiKey)}'`,
      `export XLB_MODEL_PROVIDER_ID='${this.escapeSingleQuoted(input.providerId)}'`,
      `export XLB_MODEL_BASE_URL='${this.escapeSingleQuoted(input.baseUrl)}'`,
      `export XLB_MODEL_ID='${this.escapeSingleQuoted(input.modelId)}'`,
      `export XLB_MODEL_ALLOWED_IDS='${this.escapeSingleQuoted(
        JSON.stringify(
          Array.isArray(input.allowedModelIds)
            ? input.allowedModelIds
                .filter((value) => typeof value === "string" && value.trim())
                .map((value) => value.trim())
            : [],
        ),
      )}'`,
      "",
      "python3 - <<'PY'",
      "import json",
      "import os",
      "from datetime import datetime, timezone",
      "from pathlib import Path",
      "",
      "def is_dict(value):",
      "    return isinstance(value, dict)",
      "",
      "def remove_provider_scoped_keys(record, provider_id):",
      "    if not is_dict(record) or not provider_id:",
      "        return {}",
      "    next_record = dict(record)",
      "    for key in list(next_record.keys()):",
      "        if key == provider_id or key == f'{provider_id}:default' or key.startswith(f'{provider_id}:') or key.startswith(f'{provider_id}-'):",
      "            del next_record[key]",
      "    return next_record",
      "",
      "def resolve_model_compat(model_id):",
      "    normalized = model_id.strip().lower() if isinstance(model_id, str) else ''",
      "    compat = {",
      "        'supportsUsageInStreaming': False,",
      "    }",
      "    if not normalized:",
      "        return compat",
      "    if normalized.startswith('qwen'):",
      "        compat['supportsStrictMode'] = False",
      "        compat['thinkingFormat'] = 'qwen'",
      "        return compat",
      "    if normalized.startswith('glm'):",
      "        compat['thinkingFormat'] = 'zai'",
      "        return compat",
      "    if normalized.startswith('gpt-') or normalized == 'gpt-4o' or normalized.startswith('o1') or normalized.startswith('o3') or normalized.startswith('o4'):",
      "        compat['thinkingFormat'] = 'openai'",
      "        return compat",
      "    return compat",
      "",
      "def ensure_provider_config(providers, provider_id, model_id, base_url, api_key):",
      "    current_provider = dict(providers.get(provider_id) or {}) if is_dict(providers.get(provider_id)) else {}",
      "    current_provider['api'] = 'openai-completions'",
      "    current_provider['apiKey'] = api_key",
      "    current_provider['baseUrl'] = base_url",
      "    models = list(current_provider.get('models') or []) if isinstance(current_provider.get('models'), list) else []",
      "    if not any(is_dict(item) and item.get('id') == model_id for item in models):",
      "        models.append({",
      "            'id': model_id,",
      "            'name': f'{model_id} (Custom Provider)',",
      "            'input': ['text', 'image'],",
      "            'cost': {",
      "                'input': 0,",
      "                'output': 0,",
      "                'cacheRead': 0,",
      "                'cacheWrite': 0,",
      "            },",
      "        })",
      "    for item in models:",
      "        if not is_dict(item):",
      "            continue",
      "        if not isinstance(item.get('name'), str) or not item.get('name').strip():",
      "            item['name'] = f\"{item.get('id') or model_id} (Custom Provider)\"",
      "        next_input = set()",
      "        if isinstance(item.get('input'), list):",
      "            for value in item['input']:",
      "                if isinstance(value, str) and value.strip():",
      "                    next_input.add(value.strip())",
      "        next_input.add('text')",
      "        next_input.add('image')",
      "        item['input'] = list(next_input)",
      "        cost = dict(item.get('cost') or {}) if is_dict(item.get('cost')) else {}",
      "        cost['input'] = float(cost.get('input') or 0)",
      "        cost['output'] = float(cost.get('output') or 0)",
      "        cost['cacheRead'] = float(cost.get('cacheRead') or 0)",
      "        cost['cacheWrite'] = float(cost.get('cacheWrite') or 0)",
      "        item['cost'] = cost",
      "        item['contextWindow'] = max(int(item.get('contextWindow') or 0), 262144)",
      "        item['maxTokens'] = max(int(item.get('maxTokens') or 0), 8192)",
      "        item['reasoning'] = False",
      "        compat = dict(item.get('compat') or {}) if is_dict(item.get('compat')) else {}",
      "        next_compat = resolve_model_compat(str(item.get('id') or model_id))",
      "        compat['supportsUsageInStreaming'] = next_compat['supportsUsageInStreaming']",
      "        if 'supportsStrictMode' in next_compat:",
      "            compat['supportsStrictMode'] = next_compat['supportsStrictMode']",
      "        else:",
      "            compat.pop('supportsStrictMode', None)",
      "        if isinstance(next_compat.get('thinkingFormat'), str) and next_compat.get('thinkingFormat').strip():",
      "            compat['thinkingFormat'] = next_compat['thinkingFormat']",
      "        else:",
      "            compat.pop('thinkingFormat', None)",
      "        item['compat'] = compat",
      "    current_provider['models'] = models",
      "    providers[provider_id] = current_provider",
      "",
      "def collect_managed_model_ids(providers, provider_id, model_id, raw_allowed_model_ids):",
      "    values = []",
      "    seen = set()",
      "    def push(value):",
      "        normalized = value.strip() if isinstance(value, str) else ''",
      "        if not normalized or normalized in seen:",
      "            return",
      "        seen.add(normalized)",
      "        values.append(normalized)",
      "    if isinstance(raw_allowed_model_ids, list):",
      "        for value in raw_allowed_model_ids:",
      "            push(value)",
      "    push(model_id)",
      "    provider_order = []",
      "    if isinstance(provider_id, str) and provider_id.strip():",
      "        provider_order.append(provider_id.strip())",
      "    for provider_name in provider_order:",
      "        provider_config = providers.get(provider_name) if is_dict(providers.get(provider_name)) else {}",
      "        provider_models = provider_config.get('models') if isinstance(provider_config.get('models'), list) else []",
      "        for item in provider_models:",
      "            if is_dict(item):",
      "                push(item.get('id'))",
      "    return values",
      "",
      "provider_id = os.environ.get('XLB_MODEL_PROVIDER_ID', '').strip() or 'openai'",
      "base_url = os.environ.get('XLB_MODEL_BASE_URL', '').strip()",
      "model_id = os.environ.get('XLB_MODEL_ID', '').strip()",
      "api_key = os.environ.get('OPENCLAW_API_KEY', '').strip()",
      "raw_allowed_model_ids = json.loads(os.environ.get('XLB_MODEL_ALLOWED_IDS', '[]') or '[]')",
      "config_path = Path('/root/.openclaw/openclaw.json')",
      "if not config_path.exists():",
      "    raise SystemExit('openclaw.json not found')",
      "config = json.loads(config_path.read_text() or '{}')",
      "if not is_dict(config):",
      "    config = {}",
      "config['meta'] = dict(config.get('meta') or {}) if is_dict(config.get('meta')) else {}",
      "config['meta']['lastTouchedAt'] = datetime.now(timezone.utc).isoformat()",
      "config['models'] = dict(config.get('models') or {}) if is_dict(config.get('models')) else {}",
      "if not isinstance(config['models'].get('mode'), str) or not config['models'].get('mode', '').strip():",
      "    config['models']['mode'] = 'merge'",
      "providers = dict(config['models'].get('providers') or {}) if is_dict(config['models'].get('providers')) else {}",
      "providers = remove_provider_scoped_keys(providers, provider_id)",
      "ensure_provider_config(providers, provider_id, model_id, base_url, api_key)",
      "managed_model_ids = collect_managed_model_ids(providers, provider_id, model_id, raw_allowed_model_ids)",
      "config['models']['providers'] = providers",
      "config['auth'] = dict(config.get('auth') or {}) if is_dict(config.get('auth')) else {}",
      "config['auth']['profiles'] = dict(config['auth'].get('profiles') or {}) if is_dict(config['auth'].get('profiles')) else {}",
      "config['auth']['profiles'][f'{provider_id}:default'] = {",
      "    'provider': provider_id,",
      "    'mode': 'api_key',",
      "}",
      "config['agents'] = dict(config.get('agents') or {}) if is_dict(config.get('agents')) else {}",
      "config['agents']['defaults'] = dict(config['agents'].get('defaults') or {}) if is_dict(config['agents'].get('defaults')) else {}",
      "config['agents']['defaults']['model'] = dict(config['agents']['defaults'].get('model') or {}) if is_dict(config['agents']['defaults'].get('model')) else {}",
      "config['agents']['defaults']['model']['primary'] = f'{provider_id}/{model_id}'",
      "config['agents']['defaults']['model']['fallbacks'] = [",
      "    f'{provider_id}/{managed_model_id}'",
      "    for managed_model_id in managed_model_ids",
      "    if managed_model_id != model_id",
      "]",
      "existing_default_models = dict(config['agents']['defaults'].get('models') or {}) if is_dict(config['agents']['defaults'].get('models')) else {}",
      "for managed_model_id in managed_model_ids:",
      "    managed_key = f'{provider_id}/{managed_model_id}'",
      "    existing_default_models[managed_key] = dict(existing_default_models.get(managed_key) or {}) if is_dict(existing_default_models.get(managed_key)) else {}",
      "config['agents']['defaults']['models'] = existing_default_models",
      "config['gateway'] = dict(config.get('gateway') or {}) if is_dict(config.get('gateway')) else {}",
      "config['gateway']['http'] = dict(config['gateway'].get('http') or {}) if is_dict(config['gateway'].get('http')) else {}",
      "config['gateway']['http']['endpoints'] = dict(config['gateway']['http'].get('endpoints') or {}) if is_dict(config['gateway']['http'].get('endpoints')) else {}",
      "config['gateway']['http']['endpoints']['responses'] = dict(config['gateway']['http']['endpoints'].get('responses') or {}) if is_dict(config['gateway']['http']['endpoints'].get('responses')) else {}",
      "config['gateway']['http']['endpoints']['responses']['enabled'] = True",
      "config_path.write_text(json.dumps(config, indent=2) + '\\n')",
      "agent_dir = Path('/root/.openclaw/agents/main/agent')",
      "agent_dir.mkdir(parents=True, exist_ok=True)",
      "auth_path = agent_dir / 'auth-profiles.json'",
      "existing_auth_store = json.loads(auth_path.read_text() or '{}') if auth_path.exists() else {}",
      "auth_store = dict(existing_auth_store or {}) if is_dict(existing_auth_store) else {}",
      "auth_store['version'] = 1",
      "auth_store['profiles'] = dict(auth_store.get('profiles') or {}) if is_dict(auth_store.get('profiles')) else {}",
      "auth_store['lastGood'] = dict(auth_store.get('lastGood') or {}) if is_dict(auth_store.get('lastGood')) else {}",
      "auth_store['usageStats'] = dict(auth_store.get('usageStats') or {}) if is_dict(auth_store.get('usageStats')) else {}",
      "auth_store['profiles'][f'{provider_id}:default'] = {",
      "    'type': 'api_key',",
      "    'provider': provider_id,",
      "    'key': api_key,",
      "}",
      "auth_store['lastGood'][provider_id] = f'{provider_id}:default'",
      "auth_path.write_text(json.dumps(auth_store, indent=2) + '\\n')",
      "print(f'model switched to {provider_id}/{model_id}')",
      "PY",
      "",
      "loginctl enable-linger root >/dev/null 2>&1 || true",
      "mkdir -p \"$XDG_RUNTIME_DIR\"",
      "chmod 700 \"$XDG_RUNTIME_DIR\" || true",
      "systemctl start user@0.service >/dev/null 2>&1 || true",
      "",
      "restarted=0",
      "if command -v openclaw >/dev/null 2>&1; then",
      "  if openclaw gateway restart >/tmp/xiaolanbu-gateway-model-switch.log 2>&1; then",
      "    restarted=1",
      "  fi",
      "fi",
      "if [ \"$restarted\" -ne 1 ]; then",
      "  systemctl --user daemon-reload >/dev/null 2>&1 || true",
      "  if systemctl --user restart openclaw-gateway.service >/tmp/xiaolanbu-gateway-model-switch.log 2>&1; then",
      "    restarted=1",
      "  fi",
      "fi",
      "if [ \"$restarted\" -ne 1 ]; then",
      "  service_path=\"/root/.config/systemd/user/openclaw-gateway.service\"",
      "  exec_start=\"\"",
      "  if [ -f \"$service_path\" ]; then",
      "    exec_start=$(awk -F= '/^ExecStart=/{print substr($0, 11); exit}' \"$service_path\")",
      "  fi",
      "  if [ -n \"$exec_start\" ]; then",
      "    pkill -f \"openclaw gateway\" >/dev/null 2>&1 || true",
      "    nohup bash -lc \"$exec_start\" >/var/log/openclaw-gateway.log 2>&1 &",
      "    restarted=1",
      "  fi",
      "fi",
      "if [ \"$restarted\" -ne 1 ]; then",
      "  cat /tmp/xiaolanbu-gateway-model-switch.log 2>/dev/null || true",
      "  exit 1",
      "fi",
      "",
      "for _ in $(seq 1 25); do",
      `  if ss -lntp | grep -q ':${input.gatewayPort} '; then`,
      `    echo 'gateway listening on ${input.gatewayPort}'`,
      "    exit 0",
      "  fi",
      "  sleep 2",
      "done",
      "systemctl --user --no-pager --full status openclaw-gateway.service || true",
      "tail -n 120 /var/log/openclaw-gateway.log || true",
      `echo 'gateway port ${input.gatewayPort} did not come back after model switch'`,
      "exit 1",
      "",
    ].join("\n");
  }

  private resolveInstanceTypeCandidates(body: CreateDeploymentDto) {
    const candidates = [
      ...(body.instanceTypes ?? []),
      ...(body.instanceType ? [body.instanceType] : []),
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    return [...new Set(candidates)];
  }

  private resolveDiskCandidates(body: CreateDeploymentDto, instanceType: string) {
    const allowExplicitDiskCategory = process.env.XLB_ALLOW_EXPLICIT_DISK_CATEGORY === "true";
    const requestedDiskCategory = allowExplicitDiskCategory ? body.systemDiskCategory : undefined;
    const base = {
      systemDiskCategory: requestedDiskCategory,
      systemDiskSize: body.systemDiskSize,
      usesExplicitSystemDiskCategory: Boolean(requestedDiskCategory),
      attemptLabel: requestedDiskCategory
        ? `${instanceType} · ${requestedDiskCategory}`
        : instanceType,
    };

    if (!requestedDiskCategory) {
      return [base];
    }

    return [
      base,
      {
        systemDiskCategory: undefined,
        systemDiskSize: body.systemDiskSize,
        usesExplicitSystemDiskCategory: false,
        attemptLabel: `${instanceType} · 默认系统盘`,
      },
    ];
  }

  private isRetryableInstanceTypeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return [
      "Zone.NotOnSale",
      "OperationDenied.NoStock",
      "InvalidResourceType.NotSupported",
      "InvalidInstanceType.NotSupportDiskCategory",
      "InvalidSystemDiskCategory.ValueNotSupported",
    ].some((pattern) => message.includes(pattern));
  }

  private isRetryableDiskCategoryError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "InvalidInstanceType.NotSupportDiskCategory",
      "InvalidSystemDiskCategory.ValueNotSupported",
    ].some((pattern) => message.includes(pattern));
  }

  private describeProvisioningError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Zone.NotOnSale")) {
      return "当前可用区该资源已停售或暂不可用";
    }

    if (message.includes("OperationDenied.NoStock")) {
      return "当前可用区库存不足";
    }

    if (message.includes("InvalidResourceType.NotSupported")) {
      return "当前可用区不支持该实例规格";
    }

    if (message.includes("InvalidInstanceType.NotSupportDiskCategory")) {
      return "当前规格与系统盘类型不兼容";
    }

    if (message.includes("InvalidSystemDiskCategory.ValueNotSupported")) {
      return "当前规格不支持所选系统盘类型";
    }

    if (message.includes("ReadTimeout")) {
      return "阿里云接口响应超时";
    }

    return message;
  }

  private buildProvisioningException(
    error: unknown,
    attempts: Array<{
      instanceType: string;
      status: "success" | "error";
      requestId?: string;
      message?: string;
      retryable: boolean;
    }>,
  ) {
    const summary = attempts
      .map((item) =>
        item.status === "success"
          ? `${item.instanceType}（成功）`
          : `${item.instanceType}（${item.message ?? "失败"}）`,
      )
      .join(" -> ");

    const fallbackMessage = error instanceof Error ? error.message : "未知错误";

    return new BadRequestException({
      message: summary
        ? `实例创建失败，已尝试：${summary}`
        : `实例创建失败：${fallbackMessage}`,
      attempts,
      rawMessage: fallbackMessage,
    });
  }

  private resolveUserData(
    body: CreateDeploymentDto,
    gatewayProvision?: {
      apiKey: string;
      tokenId: string;
      keyName?: string;
      keyAlias?: string | null;
      baseUrl: string;
      modelId: string;
      providerId: string;
    },
  ) {
    if (body.userData) {
      return body.userData;
    }

    const injectedApiKey = gatewayProvision?.apiKey ?? body.openclawApiKey;

    if (!injectedApiKey) {
      return undefined;
    }

    const serviceName = "openclaw-gateway.service";
    const servicePath = `/root/.config/systemd/user/${serviceName}`;
    const gatewayPort = body.openclawGatewayPort ?? 18789;
    const script = [
      "#!/bin/bash",
      "set -euo pipefail",
      "exec > >(tee -a /var/log/xiaolanbu-bootstrap.log) 2>&1",
      "",
      "export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
      "export HOME=/root",
      "export USER=root",
      "export LOGNAME=root",
      "export XDG_RUNTIME_DIR=/run/user/0",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus",
      `export OPENCLAW_API_KEY='${this.escapeSingleQuoted(injectedApiKey)}'`,
      "",
      'echo "[xiaolanbu] bootstrap started at $(date -Is)"',
      'echo "[xiaolanbu] using openclaw-manager at $(command -v openclaw-manager)"',
      "",
      "openclaw-manager init --non-interactive \\",
      `  --provider-id ${body.openclawProviderId ?? gatewayProvision?.providerId ?? this.resolveConfiguredProviderId()} \\`,
      `  --base-url ${body.openclawBaseUrl ?? gatewayProvision?.baseUrl ?? this.resolveConfiguredOpenAiBaseUrl()} \\`,
      `  --model-id ${body.openclawModelId ?? gatewayProvision?.modelId ?? this.resolveConfiguredGatewayModel()} \\`,
      `  --gateway-port ${gatewayPort} \\`,
      `  --gateway-bind ${body.openclawGatewayBind ?? "loopback"}`,
      "",
      "python3 - <<'PY'",
      "import json",
      "from pathlib import Path",
      "config_path = Path('/root/.openclaw/openclaw.json')",
      "if config_path.exists():",
      "    config = json.loads(config_path.read_text())",
      "    gateway = config.get('gateway') if isinstance(config.get('gateway'), dict) else {}",
      "    http = gateway.get('http') if isinstance(gateway.get('http'), dict) else {}",
      "    endpoints = http.get('endpoints') if isinstance(http.get('endpoints'), dict) else {}",
      "    responses = endpoints.get('responses') if isinstance(endpoints.get('responses'), dict) else {}",
      "    responses['enabled'] = True",
      "    endpoints['responses'] = responses",
      "    http['endpoints'] = endpoints",
      "    gateway['http'] = http",
      "    config['gateway'] = gateway",
      "    config_path.write_text(json.dumps(config, indent=2) + '\\n')",
      "PY",
      "",
      "loginctl enable-linger root || true",
      "mkdir -p \"$XDG_RUNTIME_DIR\"",
      "chmod 700 \"$XDG_RUNTIME_DIR\"",
      "systemctl start user@0.service || true",
      "",
      `if [ ! -f "${servicePath}" ]; then`,
      `  echo "[xiaolanbu] missing service file: ${servicePath}"`,
      "  exit 1",
      "fi",
      "",
      `if ! systemctl --user daemon-reload; then`,
      '  echo "[xiaolanbu] systemctl --user daemon-reload failed"',
      "fi",
      "",
      `if ! systemctl --user enable --now ${serviceName}; then`,
      `  echo "[xiaolanbu] systemctl --user failed, falling back to ExecStart from ${servicePath}"`,
      `  exec_start=$(awk -F= '/^ExecStart=/{print substr($0, 11); exit}' "${servicePath}")`,
      '  if [ -z "$exec_start" ]; then',
      '    echo "[xiaolanbu] ExecStart not found in service file"',
      "    exit 1",
      "  fi",
      '  nohup bash -lc "$exec_start" >/var/log/openclaw-gateway.log 2>&1 &',
      "fi",
      "",
      "sleep 3",
      `if ! ss -lntp | grep -q ':${gatewayPort} '; then`,
      `  echo "[xiaolanbu] gateway port ${gatewayPort} is not listening"`,
      `  systemctl --user --no-pager --full status ${serviceName} || true`,
      "  tail -n 100 /var/log/openclaw-gateway.log || true",
      "  exit 1",
      "fi",
      "",
      `systemctl --user --no-pager --full status ${serviceName} || true`,
      `ss -lntp | grep ':${gatewayPort}' || true`,
      'echo "[xiaolanbu] bootstrap finished at $(date -Is)"',
      "",
    ].join("\n");

    return Buffer.from(script, "utf8").toString("base64");
  }

  private async resolveAccessInfo(input: {
    regionId: string;
    instanceId: string;
    publicIpAddress: string[];
    gatewayPort: number;
    gatewayBind: string;
  }) {
    const publicIp = input.publicIpAddress[0];
    if (!publicIp) {
      return null;
    }

    const sshTunnel = `ssh -N -L ${input.gatewayPort}:127.0.0.1:${input.gatewayPort} root@${publicIp}`;
    const tokenSource = "/root/.openclaw/openclaw.json (gateway.auth.token)";
    const browserControlPort = input.gatewayPort + 2;

    const assistantReady = await this.aliyunEcsService.waitForCloudAssistantReady({
      regionId: input.regionId,
      instanceIds: [input.instanceId],
      timeoutMs: 120000,
      intervalMs: 5000,
    });

    if (!assistantReady.success) {
      return {
        sshTunnel,
        tokenSource,
      };
    }

    const token = await this.readGatewayToken({
      regionId: input.regionId,
      instanceId: input.instanceId,
    });
    if (!token) {
      return {
        sshTunnel,
        tokenSource,
      };
    }

    const dashboardUrl =
      input.gatewayBind === "loopback"
        ? `http://127.0.0.1:${input.gatewayPort}/#token=${token}`
        : `http://${publicIp}:${input.gatewayPort}/#token=${token}`;

    const browserControlUrl =
      input.gatewayBind === "loopback"
        ? `http://127.0.0.1:${browserControlPort}/`
        : `http://${publicIp}:${browserControlPort}/`;

    return {
      sshTunnel,
      dashboardUrl,
      tokenSource,
      browserControlUrl,
    };
  }

  private async readGatewayToken(input: { regionId: string; instanceId: string }) {
    const attempts = 6;

    for (let index = 0; index < attempts; index += 1) {
      const result = await this.aliyunEcsService.runCommand({
        regionId: input.regionId,
        instanceId: input.instanceId,
        timeoutSeconds: 20,
        command: [
          "#!/bin/bash",
          "set -euo pipefail",
          "python3 - <<'PY'",
          "import json",
          "from pathlib import Path",
          "config_path = Path('/root/.openclaw/openclaw.json')",
          "if not config_path.exists():",
          "    raise SystemExit(0)",
          "config = json.loads(config_path.read_text())",
          "token = ((config.get('gateway') or {}).get('auth') or {}).get('token', '')",
          "if token:",
          "    print(token)",
          "PY",
        ].join("\n"),
      });

      const token = this.normalizeGatewayToken(result.output);
      if (token) {
        return token;
      }

      if (index < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    return null;
  }

  private normalizeGatewayToken(value?: string) {
    const token = value?.trim();
    if (!token) {
      return null;
    }

    return /^[a-f0-9]{32,128}$/i.test(token) ? token : null;
  }

  private escapeSingleQuoted(value: string) {
    return value.replace(/'/g, `'\"'\"'`);
  }

  private resolveConfiguredGatewayModel() {
    const catalog = this.resolveGatewayModelCatalog();
    return catalog.find((item) => item.isDefault)?.id || catalog[0]?.id || "gpt-5.2";
  }

  private resolveManagedGatewayKeyModelIds() {
    const catalogModelIds = Array.from(
      new Set(
        this.resolveGatewayModelCatalog()
          .map((item) => this.normalizeGatewayModelId(item.id))
          .filter(Boolean),
      ),
    );

    if (catalogModelIds.length > 0) {
      return catalogModelIds;
    }

    return [this.resolveConfiguredGatewayModel()];
  }

  private resolveGatewayModelGroupName(item: Pick<GatewayModelCatalogEntry, "profileId" | "providerId">) {
    const profileId = item.profileId?.trim().toLowerCase() || "";
    const providerId = item.providerId?.trim().toLowerCase() || "";

    if (profileId === "qwen" || profileId.includes("dashscope") || profileId.includes("qwen")) {
      return "Qwen";
    }
    if (profileId === "aportal") {
      return "OpenAI";
    }
    if (providerId === "openai") {
      return "OpenAI";
    }

    return profileId || providerId || "Other";
  }

  private buildGatewayModelLabel(item: GatewayModelCatalogEntry) {
    const groupName = this.resolveGatewayModelGroupName(item);
    const modelName = item.id?.trim() || item.upstreamModelId?.trim() || "unnamed-model";
    return `${groupName} / ${modelName}`;
  }

  private resolveModelProfileEnvPrefix(profileId: string) {
    const normalized =
      profileId
        ?.trim()
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase() || "DEFAULT";
    return `XLB_GATEWAY_MODEL_PROFILE_${normalized}`;
  }

  private resolveGatewayProfile(profileId?: string | null) {
    const normalizedProfileId = profileId?.trim() || "default";
    const prefix = this.resolveModelProfileEnvPrefix(normalizedProfileId);
    const providerId =
      process.env[`${prefix}_PROVIDER_ID`]?.trim() ||
      process.env.XLB_GATEWAY_PROVIDER_ID?.trim() ||
      "openai";
    const baseUrl =
      process.env[`${prefix}_BASE_URL`]?.trim() ||
      process.env.XLB_UPSTREAM_OPENAI_BASE_URL?.trim() ||
      process.env.XLB_OPENAI_BASE_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.aportal.ai/v1";
    const apiKey =
      process.env[`${prefix}_API_KEY`]?.trim() ||
      process.env.XLB_UPSTREAM_OPENAI_API_KEY?.trim() ||
      process.env.XLB_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.DASHSCOPE_API_KEY?.trim() ||
      "";

    return {
      id: normalizedProfileId,
      providerId,
      baseUrl,
      apiKey,
    };
  }

  private resolveConfiguredProviderId(modelId?: string | null) {
    const normalizedModelId = this.normalizeGatewayModelId(modelId);
    const entry = this.resolveGatewayModelCatalog().find((item) => item.id === normalizedModelId);
    return entry?.providerId || this.resolveGatewayProfile("default").providerId;
  }

  private resolveConfiguredOpenAiBaseUrl() {
    const configuredDefault = this.resolveConfiguredGatewayModel();
    const entry = this.resolveGatewayModelCatalog().find((item) => item.id === configuredDefault);
    return entry?.baseUrl || this.resolveGatewayProfile("default").baseUrl;
  }

  private resolveConfiguredOpenAiApiKey(modelId?: string | null) {
    const normalizedModelId = this.normalizeGatewayModelId(modelId);
    const entry = this.resolveGatewayModelCatalog().find((item) => item.id === normalizedModelId);
    return entry?.apiKey || this.resolveGatewayProfile("default").apiKey;
  }

  private isLegacyGatewayModelId(modelId?: string | null) {
    const normalized = modelId?.trim().toLowerCase();
    return normalized === "qwen35-plus" || normalized === "qwen3.5-plus";
  }

  private normalizeGatewayModelId(modelId?: string | null) {
    const normalized = modelId?.trim();
    if (!normalized) {
      return this.resolveConfiguredGatewayModel();
    }

    if (this.isLegacyGatewayModelId(normalized)) {
      return "qwen35-plus";
    }

    return normalized;
  }

  private resolveGatewayModelCatalog(): GatewayModelCatalogEntry[] {
    const rawCatalog = process.env.XLB_GATEWAY_MODEL_CATALOG?.trim() || "";
    const configuredDefault =
      process.env.XLB_GATEWAY_MODEL?.trim() ||
      process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() ||
      "gpt-5.2";
    const fallbackUpstream = process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() || configuredDefault;
    const items: GatewayModelCatalogEntry[] = [];
    const seen = new Set<string>();
    const push = (id: string, upstreamModelId?: string | null, profileId?: string | null) => {
      const normalizedId = this.normalizeGatewayModelId(id);
      if (!normalizedId || seen.has(normalizedId)) {
        return;
      }
      const profile = this.resolveGatewayProfile(profileId);
      seen.add(normalizedId);
      items.push({
        id: normalizedId,
        upstreamModelId: upstreamModelId?.trim() || normalizedId,
        label: normalizedId,
        isDefault: normalizedId === this.normalizeGatewayModelId(configuredDefault),
        profileId: profile.id,
        providerId: profile.providerId,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
      });
    };

    if (rawCatalog) {
      for (const chunk of rawCatalog.split(",")) {
        const entry = chunk.trim();
        if (!entry) {
          continue;
        }
        const [rawAliasPart, upstreamPart] = entry.includes("=") ? entry.split("=", 2) : [entry, entry];
        const upstreamWithProfile = upstreamPart.trim();
        const atIndex = upstreamWithProfile.lastIndexOf("@");
        const upstream =
          atIndex >= 0 ? upstreamWithProfile.slice(0, atIndex).trim() : upstreamWithProfile;
        const profileId =
          atIndex >= 0 ? upstreamWithProfile.slice(atIndex + 1).trim() : "default";
        const aliasPart = entry.includes("=") ? rawAliasPart : upstream;
        push(aliasPart, upstream, profileId);
      }
    }

    for (const item of DEFAULT_GATEWAY_MODEL_CATALOG) {
      push(item.id, item.upstreamModelId, item.profileId);
    }

    push(configuredDefault, fallbackUpstream, "default");

    if (!items.some((item) => item.isDefault) && items[0]) {
      items[0] = {
        ...items[0],
        isDefault: true,
      };
    }

    return items;
  }

  private refreshDeploymentGatewayDefaults(
    deployment: ReturnType<StoreService["getDeployment"]>,
  ) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const gatewayKey =
      deployment.gatewayKey && typeof deployment.gatewayKey === "object" ? deployment.gatewayKey : undefined;
    const normalizedModelId = this.normalizeGatewayModelId(
      gatewayKey?.modelId || (typeof metadata.modelId === "string" ? metadata.modelId : undefined),
    );
    const gatewayKeyChanged = gatewayKey ? gatewayKey.modelId !== normalizedModelId : false;
    const metadataChanged =
      typeof metadata.modelId === "string" && metadata.modelId !== normalizedModelId;

    if (!gatewayKeyChanged && !metadataChanged) {
      return deployment;
    }

    return {
      ...deployment,
      gatewayKey: gatewayKey
        ? {
            ...gatewayKey,
            modelId: normalizedModelId,
          }
        : gatewayKey,
      metadata: {
        ...metadata,
        modelId: normalizedModelId,
      },
    };
  }

  private createDeploymentId() {
    return `dep_${Date.now()}${randomBytes(3).toString("hex")}`;
  }

  private async withDeploymentMutationLock<T>(deploymentId: string, operation: () => Promise<T>) {
    const lockId = this.hashDeploymentLockId(deploymentId);
    const result = await this.postgresStateService.withAdvisoryLock(lockId, 15000, operation);
    if (!result.acquired) {
      throw new ConflictException("deployment is busy, retry later");
    }
    return result.value as T;
  }

  private hashDeploymentLockId(deploymentId: string) {
    let hash = 17;
    for (const char of deploymentId) {
      hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    return Math.abs(hash) || 17;
  }

  private shouldQueueDeploymentJobs() {
    return this.queueService.isEnabled() && !this.queueService.isWorkerMode();
  }

  private async resolveGatewayProvision(input: {
    deploymentId: string;
    workspaceId: string;
    ownerUserId?: string;
    deploymentName: string;
    requestedModelId?: string;
  }) {
    const baseUrl = this.liteLlmProxyService.getPublicBaseUrl();
    const internalProxyUrl = this.liteLlmProxyService.getProxyBaseUrl();

    if (!baseUrl || !internalProxyUrl) {
      return null;
    }

    const modelId = input.requestedModelId ?? this.resolveConfiguredGatewayModel();
    const allowedModelIds = this.resolveManagedGatewayKeyModelIds();
    const providerId = this.resolveConfiguredProviderId(modelId);
    const keyAlias = `deployment:${input.deploymentId}:${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const ownerUserId =
      input.ownerUserId || (await this.storeService.getBillingUserIdForWorkspaceAsync(input.workspaceId));
    const wallet = await this.storeService.getWalletByUserIdAsync(ownerUserId);
    const initialBudget = this.resolveInitialGatewayKeyBudget(wallet.balanceCny);
    const generated = await this.liteLlmProxyService.generateVirtualKey({
      models: allowedModelIds,
      maxBudget: initialBudget,
      keyAlias,
      metadata: {
        user_id: ownerUserId,
        workspace_id: input.workspaceId,
        deployment_id: input.deploymentId,
        deployment_name: input.deploymentName,
      },
    });

    if (wallet.balanceCny <= 0) {
      await this.liteLlmProxyService.updateVirtualKey({
        key: generated.key,
        maxBudget: initialBudget ?? 0,
        blocked: true,
      });
    }

    return {
      apiKey: generated.key,
      tokenId: generated.token,
      keyName: generated.keyName,
      keyAlias: generated.keyAlias ?? keyAlias,
      baseUrl,
      modelId,
      providerId,
    };
  }

  private async ensureLocalDeploymentGatewayKey(
    deployment: ReturnType<StoreService["getDeployment"]>,
  ) {
    if (deployment.mode !== "local") {
      return deployment;
    }

    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const providerId =
      typeof metadata.providerId === "string" && metadata.providerId.trim()
        ? metadata.providerId.trim()
        : process.env.XLB_GATEWAY_PROVIDER_ID?.trim() || "openai";
    const requestedModelId = this.normalizeGatewayModelId(
      deployment.gatewayKey?.modelId ||
        (typeof metadata.modelId === "string" && metadata.modelId.trim()
          ? metadata.modelId.trim()
          : undefined),
    );
    const gatewayBaseUrl =
      this.liteLlmProxyService.getPublicBaseUrl() ||
      deployment.gatewayKey?.baseUrl ||
      deployment.gatewayUrl ||
      (typeof metadata.baseUrl === "string" ? metadata.baseUrl : "");

    if (!this.liteLlmProxyService.getProxyBaseUrl() || !gatewayBaseUrl) {
      return deployment;
    }

    const wallet = await this.storeService.getWalletByUserIdAsync(
      deployment.ownerUserId || (await this.storeService.getBillingUserIdForWorkspaceAsync(deployment.workspaceId)),
    );
    const remainingBalance = Math.max(wallet.balanceCny, 0);
    const shouldBlock = wallet.balanceCny <= 0;
    const secretKey = deployment.gatewayKey?.secretKey?.trim();
    const tokenId = deployment.gatewayKey?.tokenId?.trim();

    if (!secretKey || !tokenId) {
      return await this.rotateLocalDeploymentGatewayKey(deployment, {
        baseUrl: gatewayBaseUrl,
        providerId,
        requestedModelId,
      });
    }

    try {
      const info = await this.liteLlmProxyService.getVirtualKeyInfo(secretKey);
      const currentSpend = this.asNonNegativeNumber(info.info.spend);
      const targetBudget = this.roundCurrency(currentSpend + remainingBalance);
      const blocked = info.info.blocked === true;
      const maxBudget = this.asNullableNumber(info.info.max_budget);
      const needsBudgetUpdate =
        typeof maxBudget !== "number" || Math.abs(maxBudget - targetBudget) > 0.000001;
      const needsBlockUpdate = blocked !== shouldBlock;
      const needsBaseUrlRefresh = deployment.gatewayKey?.baseUrl !== gatewayBaseUrl;
      const storedModelId = this.normalizeGatewayModelId(deployment.gatewayKey?.modelId);
      const needsModelRefresh =
        storedModelId !== requestedModelId ||
        deployment.gatewayKey?.modelId !== requestedModelId ||
        (typeof metadata.modelId === "string" && metadata.modelId.trim() !== requestedModelId);

      if (needsBudgetUpdate || needsBlockUpdate) {
        await this.liteLlmProxyService.updateVirtualKey({
          key: secretKey,
          maxBudget: targetBudget,
          blocked: shouldBlock,
        });
      }

      if (needsBaseUrlRefresh || needsModelRefresh) {
        return await this.storeService.updateDeployment(deployment.id, {
          gatewayUrl: gatewayBaseUrl,
          gatewayKey: {
            tokenId,
            secretKey,
            keyName: deployment.gatewayKey?.keyName,
            keyAlias: deployment.gatewayKey?.keyAlias,
            modelId: requestedModelId,
            baseUrl: gatewayBaseUrl,
          },
          metadata: {
            ...metadata,
            baseUrl: gatewayBaseUrl,
            providerId,
            modelId: requestedModelId,
          },
        });
      }

      return deployment;
    } catch {
      return await this.rotateLocalDeploymentGatewayKey(deployment, {
        baseUrl: gatewayBaseUrl,
        providerId,
        requestedModelId,
      });
    }
  }

  private async rotateLocalDeploymentGatewayKey(
    deployment: ReturnType<StoreService["getDeployment"]>,
    input: {
      baseUrl: string;
      providerId: string;
      requestedModelId?: string;
    },
  ) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
      const replacement = await this.resolveGatewayProvision({
        deploymentId: deployment.id,
        workspaceId: deployment.workspaceId,
        ownerUserId: deployment.ownerUserId,
        deploymentName: deployment.name,
        requestedModelId: input.requestedModelId,
      });

    if (!replacement) {
      return deployment;
    }

    const previousKey = deployment.gatewayKey?.secretKey?.trim();
    if (previousKey && previousKey !== replacement.apiKey) {
      try {
        await this.liteLlmProxyService.updateVirtualKey({
          key: previousKey,
          blocked: true,
          maxBudget: 0,
        });
      } catch {
        // Ignore stale-key cleanup failures and continue with the fresh key.
      }
    }

    return await this.storeService.updateDeployment(deployment.id, {
      gatewayUrl: input.baseUrl,
      gatewayKey: {
        tokenId: replacement.tokenId,
        secretKey: replacement.apiKey,
        keyName: replacement.keyName,
        keyAlias: replacement.keyAlias,
        modelId: replacement.modelId,
        baseUrl: input.baseUrl,
      },
      metadata: this.buildGatewayMetadata(metadata, {
        ...replacement,
        baseUrl: input.baseUrl,
        providerId: input.providerId,
        managedByLiteLlm: true,
        keyScope: "catalog",
        allowedModelIds: this.resolveManagedGatewayKeyModelIds(),
      }),
    });
  }

  private resolveGatewayKeyBudget() {
    const value = process.env.XLB_GATEWAY_KEY_MAX_BUDGET?.trim();
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private resolveInitialGatewayKeyBudget(balanceCny: number) {
    const positiveBalance = Number.isFinite(balanceCny) ? Math.max(balanceCny, 0) : 0;
    if (positiveBalance > 0) {
      return this.roundCurrency(positiveBalance);
    }

    return this.resolveGatewayKeyBudget() ?? 0;
  }

  private resolveLocalProvision(
    body: CreateDeploymentDto,
    deploymentId: string,
    gatewayProvision?: {
      apiKey: string;
      tokenId: string;
      keyName?: string;
      keyAlias?: string | null;
      baseUrl: string;
      modelId: string;
      providerId: string;
    } | null,
  ): ResolvedDeploymentGatewayConfig {
    const publicGatewayBaseUrl =
      process.env.XLB_GATEWAY_PUBLIC_BASE_URL?.trim() ||
      process.env.LITELLM_PUBLIC_BASE_URL?.trim() ||
      process.env.XLB_API_PUBLIC_BASE_URL?.trim() ||
      process.env.XLB_PUBLIC_API_BASE_URL?.trim();

    if (gatewayProvision && publicGatewayBaseUrl) {
      return {
        apiKey: gatewayProvision.apiKey,
        tokenId: gatewayProvision.tokenId,
        keyName: gatewayProvision.keyName,
        keyAlias: gatewayProvision.keyAlias,
        baseUrl: body.openclawBaseUrl?.trim() || publicGatewayBaseUrl,
        modelId: body.openclawModelId?.trim() || gatewayProvision.modelId,
        providerId: body.openclawProviderId?.trim() || gatewayProvision.providerId,
        managedByLiteLlm: true,
        keyScope: "catalog",
        allowedModelIds: this.resolveManagedGatewayKeyModelIds(),
      };
    }

    const requestedModelId =
      body.openclawModelId?.trim() ||
      process.env.XLB_LOCAL_GATEWAY_MODEL?.trim() ||
      process.env.XLB_GATEWAY_MODEL?.trim() ||
      process.env.XLB_LOCAL_MODEL?.trim() ||
      process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() ||
      "gpt-5.2";
    const apiKey = body.openclawApiKey?.trim() || this.resolveConfiguredOpenAiApiKey(requestedModelId);
    if (!apiKey) {
      throw new BadRequestException("本地部署缺少 OpenAI 兼容 API Key，暂时无法完成初始化。");
    }

    return {
      apiKey,
      tokenId: `local-direct:${deploymentId}`,
      keyName: "openai-compatible-direct",
      keyAlias: `local-direct:${deploymentId}`,
      baseUrl:
        body.openclawBaseUrl?.trim() ||
        process.env.XLB_LOCAL_BASE_URL?.trim() ||
        this.resolveGatewayModelCatalog().find((item) => item.id === this.normalizeGatewayModelId(requestedModelId))
          ?.baseUrl ||
        this.resolveConfiguredOpenAiBaseUrl(),
      modelId: requestedModelId,
      providerId:
        body.openclawProviderId?.trim() ||
        process.env.XLB_LOCAL_PROVIDER_ID?.trim() ||
        this.resolveConfiguredProviderId(requestedModelId),
      managedByLiteLlm: false,
    };
  }

  private resolveLocalGatewayTunnel(baseUrl: string) {
    const tunnelEnabled = process.env.XLB_GATEWAY_TUNNEL_ENABLED?.trim()?.toLowerCase();
    if (!tunnelEnabled || !["1", "true", "on", "yes", "enabled", "required"].includes(tunnelEnabled)) {
      return undefined;
    }

    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return undefined;
    }

    if (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    ) {
      return undefined;
    }

    const user = process.env.XLB_GATEWAY_TUNNEL_USER?.trim() || "xlb-tunnel";
    const sshPortCandidates = this.resolveGatewayTunnelSshPortCandidates();
    const configuredSshPort = Number(process.env.XLB_GATEWAY_TUNNEL_SSH_PORT?.trim() || "");
    const sshPort =
      Number.isFinite(configuredSshPort) && configuredSshPort > 0
        ? configuredSshPort
        : sshPortCandidates[0] || 22;
    const protocolDefaultPort = parsed.protocol === "https:" ? "443" : "80";
    const remotePort = Number(
      parsed.port || process.env.XLB_GATEWAY_TUNNEL_REMOTE_PORT?.trim() || protocolDefaultPort,
    );
    const localPort = Number(process.env.XLB_GATEWAY_TUNNEL_LOCAL_PORT?.trim() || "43030");
    const privateKey =
      this.readGatewayTunnelPrivateKey() ||
      process.env.XLB_GATEWAY_TUNNEL_PRIVATE_KEY?.trim() ||
      "";

    return {
      host: parsed.hostname,
      user,
      sshPort: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : 22,
      sshPortCandidates,
      localPort: Number.isFinite(localPort) && localPort > 0 ? localPort : 43030,
      remotePort: Number.isFinite(remotePort) && remotePort > 0 ? remotePort : 8000,
      privateKey,
    };
  }

  private resolveGatewayTunnelSshPortCandidates() {
    const configured = this.parseGatewayTunnelPortCandidates(
      process.env.XLB_GATEWAY_TUNNEL_SSH_PORT_CANDIDATES,
    );
    return configured.length > 0 ? configured : [22, 2222];
  }

  private parseGatewayTunnelPortCandidates(value?: string | null) {
    if (!value?.trim()) {
      return [];
    }

    const ports = value
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((port) => Number.isInteger(port) && port > 0);

    return Array.from(new Set(ports));
  }

  private refreshLocalDeploymentBootstrap(deployment: ReturnType<StoreService["getDeployment"]>) {
    if (deployment.mode !== "local") {
      return deployment;
    }

    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const targetPlatform = this.normalizeLocalPlatform(
      typeof metadata.platform === "string" ? metadata.platform : undefined,
    );
    const baseUrl =
      deployment.gatewayKey?.baseUrl ||
      deployment.gatewayUrl ||
      (typeof metadata.baseUrl === "string" ? metadata.baseUrl : "");
    const gatewayTunnel =
      (targetPlatform === "darwin" || targetPlatform === "win32") && baseUrl
        ? this.resolveLocalGatewayTunnel(baseUrl)
        : undefined;
    const runtimePackages = this.runtimeService.getBootstrapPackagesForPlatform(targetPlatform);
    const localGatewayRoutingMode = this.supportsLocalBackendModelRouting(deployment)
      ? "backend-model-routing"
      : "direct-model";

    return {
      ...deployment,
      metadata: {
        ...metadata,
        platform: targetPlatform,
        runtimePackages,
        gatewayTunnel,
        localGatewayRoutingMode,
        localGatewayProviderId: this.resolveLocalBootstrapProviderId(deployment),
        localGatewayModelId: this.resolveLocalBootstrapModelId(deployment),
      },
    };
  }

  private buildLocalBootstrapPayload(deployment: DeploymentRecord) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const access =
      deployment.access && typeof deployment.access === "object" ? deployment.access : {};
    const gatewayKey = deployment.gatewayKey;

    if (!gatewayKey?.secretKey || !gatewayKey.baseUrl) {
      throw new BadRequestException("当前本地 deployment 缺少可用网关密钥，请重新一键部署。");
    }

    const targetPlatform = this.normalizeLocalPlatform(
      typeof metadata.platform === "string" ? metadata.platform : undefined,
    );
    const gatewayPort = Number(metadata.gatewayPort ?? 18789);
    const browserControlPort = Number(metadata.browserControlPort ?? gatewayPort + 2);
    const gatewayToken =
      typeof metadata.gatewayToken === "string"
        ? metadata.gatewayToken
        : typeof access.dashboardUrl === "string"
          ? access.dashboardUrl.split("#token=")[1] ?? ""
          : "";
    const dashboardUrl =
      typeof access.dashboardUrl === "string" && access.dashboardUrl
        ? access.dashboardUrl
        : `http://127.0.0.1:${gatewayPort}${gatewayToken ? `/#token=${gatewayToken}` : ""}`;
    const browserControlUrl =
      typeof access.browserControlUrl === "string" && access.browserControlUrl
        ? access.browserControlUrl
        : `http://127.0.0.1:${browserControlPort}/`;
    const logPath =
      typeof metadata.logPath === "string" && metadata.logPath
        ? metadata.logPath
        : targetPlatform === "win32"
          ? "%LOCALAPPDATA%\\Xiaolanbu\\logs\\local-bootstrap.log"
          : "~/Library/Logs/Xiaolanbu/local-bootstrap.log";

    return {
      deploymentId: deployment.id,
      workspaceId: deployment.workspaceId,
      localDeviceId: this.getLocalDeploymentDeviceId(deployment),
      localDeviceLabel: this.getLocalDeploymentDeviceLabel(deployment),
      apiKey: gatewayKey.secretKey,
      providerId: this.resolveLocalBootstrapProviderId(deployment),
      baseUrl: gatewayKey.baseUrl,
      modelId: this.resolveLocalBootstrapModelId(deployment),
      gatewayPort,
      gatewayBind:
        typeof metadata.gatewayBind === "string" && metadata.gatewayBind
          ? metadata.gatewayBind
          : "loopback",
      browserControlPort,
      gatewayToken,
      dashboardUrl,
      browserControlUrl,
      tokenSource:
        typeof access.tokenSource === "string" && access.tokenSource
          ? access.tokenSource
          : "desktop-local-bootstrap (gateway.auth.token)",
      logPath,
      platform: targetPlatform,
      runtimePackages: Array.isArray(metadata.runtimePackages) ? metadata.runtimePackages : [],
      gatewayTunnel:
        metadata.gatewayTunnel && typeof metadata.gatewayTunnel === "object"
          ? metadata.gatewayTunnel
          : undefined,
      routingMode:
        typeof metadata.localGatewayRoutingMode === "string" && metadata.localGatewayRoutingMode
          ? metadata.localGatewayRoutingMode
          : "direct-model",
    };
  }

  private supportsLocalBackendModelRouting(deployment: DeploymentRecord) {
    if (deployment.mode !== "local") {
      return false;
    }

    const proxyBaseUrl = this.liteLlmProxyService.getProxyBaseUrl();
    const publicBaseUrl = this.liteLlmProxyService.getPublicBaseUrl();
    const tokenId = deployment.gatewayKey?.tokenId?.trim() ?? "";
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const gatewayBaseUrl =
      deployment.gatewayKey?.baseUrl?.trim() ||
      deployment.gatewayUrl?.trim() ||
      (typeof metadata.baseUrl === "string" ? metadata.baseUrl.trim() : "");

    if (!proxyBaseUrl || !publicBaseUrl || !tokenId || !gatewayBaseUrl) {
      return false;
    }

    if (tokenId.startsWith("direct:") || tokenId.startsWith("local-direct:")) {
      return false;
    }

    return this.normalizeComparableUrl(gatewayBaseUrl) === this.normalizeComparableUrl(publicBaseUrl);
  }

  private resolveLocalBootstrapProviderId(deployment: DeploymentRecord) {
    if (this.supportsLocalBackendModelRouting(deployment)) {
      return "openai";
    }

    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    return typeof metadata.providerId === "string" && metadata.providerId.trim()
      ? metadata.providerId.trim()
      : "openai";
  }

  private resolveLocalBootstrapModelId(deployment: DeploymentRecord) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    // `openclaw` is only the transient alias used when Xiaolanbu calls the local
    // `/v1/responses` endpoint. The persisted local OpenClaw config must keep the
    // concrete upstream model id so provider auth and model switching stay valid.
    return this.normalizeGatewayModelId(
      deployment.gatewayKey?.modelId ||
        (typeof metadata.modelId === "string" ? metadata.modelId : undefined),
    );
  }

  private normalizeComparableUrl(value?: string | null) {
    return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  }

  private collapseDuplicateLocalDeployments(deployments: DeploymentRecord[]) {
    const unique = new Map<string, DeploymentRecord>();

    for (const deployment of deployments) {
      if (deployment.mode !== "local") {
        unique.set(`deployment:${deployment.id}`, deployment);
        continue;
      }

      const key = `local:${deployment.workspaceId}:${deployment.ownerUserId ?? ""}:${
        this.getLocalDeploymentDeviceId(deployment) || deployment.id
      }`;
      const current = unique.get(key);
      if (!current || this.compareLocalDeploymentPriority(deployment, current) < 0) {
        unique.set(key, deployment);
      }
    }

    return Array.from(unique.values());
  }

  private selectPreferredLocalDeployment(deployments: DeploymentRecord[]) {
    const localDeployments = deployments.filter((item) => item.mode === "local");
    if (localDeployments.length === 0) {
      return null;
    }

    return [...localDeployments].sort((left, right) => this.compareLocalDeploymentPriority(left, right))[0];
  }

  private compareLocalDeploymentPriority(left: DeploymentRecord, right: DeploymentRecord) {
    const statusRank = (status: string) => {
      if (status === "running") {
        return 0;
      }
      if (status === "creating") {
        return 1;
      }
      if (status === "stopped") {
        return 2;
      }
      if (status === "error") {
        return 3;
      }
      return 4;
    };

    const rankDelta = statusRank(left.status) - statusRank(right.status);
    if (rankDelta !== 0) {
      return rankDelta;
    }

    const leftTime = Date.parse(left.lastHeartbeatAt || left.createdAt || "");
    const rightTime = Date.parse(right.lastHeartbeatAt || right.createdAt || "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return right.createdAt.localeCompare(left.createdAt);
  }

  private getLocalDeploymentDeviceId(deployment: DeploymentRecord) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const localRuntime =
      metadata.localRuntime && typeof metadata.localRuntime === "object"
        ? (metadata.localRuntime as Record<string, unknown>)
        : {};

    return this.normalizeLocalDeviceId(
      typeof metadata.localDeviceId === "string"
        ? metadata.localDeviceId
        : typeof localRuntime.deviceId === "string"
          ? localRuntime.deviceId
          : "",
    );
  }

  private getLocalDeploymentDeviceLabel(deployment: DeploymentRecord) {
    const metadata =
      deployment.metadata && typeof deployment.metadata === "object" ? deployment.metadata : {};
    const localRuntime =
      metadata.localRuntime && typeof metadata.localRuntime === "object"
        ? (metadata.localRuntime as Record<string, unknown>)
        : {};

    return this.normalizeLocalDeviceLabel(
      typeof metadata.localDeviceLabel === "string"
        ? metadata.localDeviceLabel
        : typeof localRuntime.deviceLabel === "string"
          ? localRuntime.deviceLabel
          : "",
    );
  }

  private normalizeLocalDeviceId(value?: string | null) {
    return typeof value === "string" ? value.trim() : "";
  }

  private normalizeLocalDeviceLabel(value?: string | null) {
    return typeof value === "string" ? value.trim() : "";
  }

  private resolveLocalDeploymentStatusFromRuntime(
    runtime: {
      ready?: boolean;
      dashboardPortOpen?: boolean;
      browserControlPortOpen?: boolean;
      installed?: boolean;
      error?: string;
    },
    fallbackStatus: DeploymentRecord["status"],
  ): DeploymentRecord["status"] {
    if (runtime.ready || (runtime.dashboardPortOpen && runtime.browserControlPortOpen)) {
      return "running";
    }

    if (runtime.error) {
      return "error";
    }

    if (runtime.installed || runtime.dashboardPortOpen || runtime.browserControlPortOpen) {
      return "stopped";
    }

    return fallbackStatus === "creating" ? "creating" : "stopped";
  }

  private normalizeLocalPlatform(platform?: string) {
    const normalized = platform?.trim().toLowerCase();
    if (normalized === "win32" || normalized === "windows" || normalized === "windows-x64") {
      return "win32";
    }

    return "darwin";
  }

  private readGatewayTunnelPrivateKey() {
    const keyPath = process.env.XLB_GATEWAY_TUNNEL_PRIVATE_KEY_PATH?.trim();
    if (!keyPath) {
      return "";
    }

    if (!existsSync(keyPath)) {
      return "";
    }

    try {
      return readFileSync(keyPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }

  private asNonNegativeNumber(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private asNullableNumber(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
