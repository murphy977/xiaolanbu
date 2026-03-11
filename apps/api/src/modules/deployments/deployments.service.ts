import { randomBytes } from "node:crypto";

import { BadRequestException, Injectable } from "@nestjs/common";

import { AliyunEcsService } from "../infrastructure/services/aliyun-ecs.service";
import { LiteLlmProxyService } from "../infrastructure/services/litellm-proxy.service";
import { StoreService } from "../store/store.service";
import { CreateDeploymentDto } from "./dto/create-deployment.dto";

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly storeService: StoreService,
    private readonly aliyunEcsService: AliyunEcsService,
    private readonly liteLlmProxyService: LiteLlmProxyService,
  ) {}

  listDeployments(workspaceId?: string) {
    return this.storeService.listDeployments(workspaceId);
  }

  async createDeployment(body: CreateDeploymentDto) {
    if (body.mode === "local") {
      return {
        deployment: await this.storeService.createDeployment(body),
        vendor: null,
      };
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

    for (const instanceType of instanceTypeCandidates) {
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
          systemDiskCategory: body.systemDiskCategory,
          systemDiskSize: body.systemDiskSize,
          internetMaxBandwidthOut: body.internetMaxBandwidthOut,
          tags: [
            { key: "product", value: "xiaolanbu" },
            { key: "workspace_id", value: body.workspaceId },
            ...(body.tags ?? []),
          ],
        });
        selectedInstanceType = instanceType;
        break;
      } catch (error) {
        lastProvisionError = error;
        if (!this.isRetryableInstanceTypeError(error)) {
          throw error;
        }
      }
    }

    if (!vendorResult) {
      throw lastProvisionError;
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

  private isRetryableInstanceTypeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return [
      "OperationDenied.NoStock",
      "InvalidResourceType.NotSupported",
      "InvalidInstanceType.NotSupportDiskCategory",
    ].some((pattern) => message.includes(pattern));
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

  private roundCurrency(value: number) {
    return Math.round(value * 1000000) / 1000000;
  }
}
