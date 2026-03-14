import { randomBytes } from "node:crypto";

import { BadRequestException, Injectable } from "@nestjs/common";

import { AliyunEcsService } from "../infrastructure/services/aliyun-ecs.service";
import { LiteLlmProxyService } from "../infrastructure/services/litellm-proxy.service";
import { RuntimeService } from "../runtime/runtime.service";
import { StoreService } from "../store/store.service";
import { CreateDeploymentDto } from "./dto/create-deployment.dto";

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly storeService: StoreService,
    private readonly aliyunEcsService: AliyunEcsService,
    private readonly liteLlmProxyService: LiteLlmProxyService,
    private readonly runtimeService: RuntimeService,
  ) {}

  listDeployments(workspaceId?: string) {
    return this.storeService.listDeployments(workspaceId);
  }

  async createDeployment(body: CreateDeploymentDto) {
    if (body.mode === "local") {
      return this.createLocalDeployment(body);
    }

    this.assertAliyunCloudInput(body);

    const instanceTypeCandidates = this.resolveInstanceTypeCandidates(body);
    const deploymentId = this.createDeploymentId();
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
      deployment: waitResult?.success ? this.storeService.getDeployment(deployment.id) : deployment,
      vendor: vendorResult,
      wait: waitResult,
    };
  }

  async updateDeploymentStatus(
    deploymentId: string,
    status: "creating" | "running" | "stopped" | "error",
  ) {
    return this.storeService.updateDeploymentStatus(deploymentId, status);
  }

  async startDeployment(deploymentId: string) {
    const deployment = this.storeService.getDeployment(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      return {
        deployment: await this.storeService.updateDeploymentStatus(deploymentId, "running"),
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
      deployment: await this.storeService.updateDeployment(deploymentId, {
        status: wait.success ? "running" : deployment.status,
        publicIpAddress: detail?.publicIpAddress,
        privateIpAddress: detail?.privateIpAddress,
        zoneId: detail?.zoneId,
      }),
      vendor,
      wait,
    };
  }

  async stopDeployment(deploymentId: string) {
    const deployment = this.storeService.getDeployment(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      return {
        deployment: await this.storeService.updateDeploymentStatus(deploymentId, "stopped"),
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
      deployment: await this.storeService.updateDeploymentStatus(
        deploymentId,
        wait.success ? "stopped" : deployment.status,
      ),
      vendor,
      wait,
    };
  }

  async restartDeployment(deploymentId: string) {
    const deployment = this.storeService.getDeployment(deploymentId);
    if (deployment.mode !== "cloud" || deployment.provider !== "aliyun") {
      return {
        deployment: await this.storeService.updateDeploymentStatus(deploymentId, "running"),
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
      deployment: await this.storeService.updateDeploymentStatus(
        deploymentId,
        wait.success ? "running" : deployment.status,
      ),
      vendor,
      wait,
    };
  }

  async destroyDeployment(deploymentId: string) {
    const deployment = this.storeService.getDeployment(deploymentId);

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
  }

  private async createLocalDeployment(body: CreateDeploymentDto) {
    const deploymentId = this.createDeploymentId();
    const liteLlmProvision = await this.resolveGatewayProvision({
      deploymentId,
      workspaceId: body.workspaceId,
      deploymentName: body.name,
      requestedModelId: body.openclawModelId?.trim() || process.env.XLB_GATEWAY_MODEL || "qwen35-plus",
    });
    const gatewayProvision = this.resolveLocalProvision(body, deploymentId, liteLlmProvision);

    const gatewayPort = body.openclawGatewayPort ?? 18789;
    const gatewayBind = body.openclawGatewayBind ?? "loopback";
    const browserControlPort = gatewayPort + 2;
    const gatewayToken = randomBytes(24).toString("hex");
    const dashboardUrl = `http://127.0.0.1:${gatewayPort}/#token=${gatewayToken}`;
    const browserControlUrl = `http://127.0.0.1:${browserControlPort}/`;
    const tokenSource = "desktop-local-bootstrap (gateway.auth.token)";
    const logPath = "~/Library/Logs/Xiaolanbu/local-bootstrap.log";
    const runtimePackages = this.runtimeService.getBootstrapPackagesForPlatform("darwin");

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
        runtimePackages,
        gatewayTokenId: gatewayProvision.tokenId,
        gatewayKeyName: gatewayProvision.keyName,
        gatewayKeyAlias: gatewayProvision.keyAlias,
      },
    });

    return {
      deployment,
      vendor: null,
      wait: null,
      bootstrap: {
        deploymentId,
        apiKey: gatewayProvision.apiKey,
        providerId: gatewayProvision.providerId,
        baseUrl: gatewayProvision.baseUrl,
        modelId: gatewayProvision.modelId,
        gatewayPort,
        gatewayBind,
        browserControlPort,
        gatewayToken,
        dashboardUrl,
        browserControlUrl,
        tokenSource,
        logPath,
        runtimePackages,
      },
    };
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
    const instanceId = deployment.vendorInstanceIds?.[0];
    if (!instanceId) {
      throw new BadRequestException(`Deployment ${deployment.id} is missing vendor instance id.`);
    }
    return instanceId;
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
      `  --provider-id ${body.openclawProviderId ?? gatewayProvision?.providerId ?? "dashscope"} \\`,
      `  --base-url ${body.openclawBaseUrl ?? gatewayProvision?.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"} \\`,
      `  --model-id ${body.openclawModelId ?? gatewayProvision?.modelId ?? "qwen3.5-plus"} \\`,
      `  --gateway-port ${gatewayPort} \\`,
      `  --gateway-bind ${body.openclawGatewayBind ?? "loopback"}`,
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

  private createDeploymentId() {
    return `dep_${Date.now()}${randomBytes(3).toString("hex")}`;
  }

  private async resolveGatewayProvision(input: {
    deploymentId: string;
    workspaceId: string;
    deploymentName: string;
    requestedModelId?: string;
  }) {
    const baseUrl = this.liteLlmProxyService.getPublicBaseUrl();
    const internalProxyUrl = this.liteLlmProxyService.getProxyBaseUrl();

    if (!baseUrl || !internalProxyUrl) {
      return null;
    }

    const modelId = input.requestedModelId ?? process.env.XLB_GATEWAY_MODEL ?? "qwen35-plus";
    const keyAlias = `deployment:${input.deploymentId}`;
    const wallet = this.storeService.getWallet(input.workspaceId);
    const initialBudget = this.resolveInitialGatewayKeyBudget(wallet.balanceCny);
    const generated = await this.liteLlmProxyService.generateVirtualKey({
      models: [modelId],
      maxBudget: initialBudget,
      keyAlias,
      metadata: {
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
      providerId: process.env.XLB_GATEWAY_PROVIDER_ID ?? "openai",
    };
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
  ) {
    const publicApiBaseUrl =
      process.env.XLB_API_DIRECT_PUBLIC_BASE_URL?.trim() ||
      process.env.XLB_API_PUBLIC_BASE_URL?.trim() ||
      process.env.XLB_PUBLIC_API_BASE_URL?.trim();

    if (gatewayProvision && publicApiBaseUrl) {
      return {
        apiKey: gatewayProvision.apiKey,
        tokenId: gatewayProvision.tokenId,
        keyName: gatewayProvision.keyName,
        keyAlias: gatewayProvision.keyAlias,
        baseUrl: body.openclawBaseUrl?.trim() || publicApiBaseUrl,
        modelId: body.openclawModelId?.trim() || gatewayProvision.modelId,
        providerId: body.openclawProviderId?.trim() || gatewayProvision.providerId,
      };
    }

    const apiKey = body.openclawApiKey?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) {
      throw new BadRequestException("本地部署缺少 DASHSCOPE_API_KEY，暂时无法完成初始化。");
    }

    return {
      apiKey,
      tokenId: `local-direct:${deploymentId}`,
      keyName: "dashscope-direct",
      keyAlias: `local-direct:${deploymentId}`,
      baseUrl:
        body.openclawBaseUrl?.trim() ||
        process.env.XLB_LOCAL_BASE_URL?.trim() ||
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelId:
        body.openclawModelId?.trim() ||
        process.env.XLB_LOCAL_MODEL?.trim() ||
        "qwen-plus",
      providerId:
        body.openclawProviderId?.trim() ||
        process.env.XLB_LOCAL_PROVIDER_ID?.trim() ||
        "openai",
    };
  }

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }
}
