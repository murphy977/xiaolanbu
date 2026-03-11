import { Injectable, InternalServerErrorException } from "@nestjs/common";
import Ecs20140526, {
  DescribeCloudAssistantStatusRequest,
  DescribeInstancesRequest,
  DescribeInstanceStatusRequest,
  DescribeInvocationResultsRequest,
  RunCommandRequest,
  RunInstancesRequest,
  RunInstancesResponseBody,
} from "@alicloud/ecs20140526";
import { Config } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";

export interface RunAliyunInstancesInput {
  regionId: string;
  imageId: string;
  instanceType: string;
  securityGroupId: string;
  vSwitchId: string;
  instanceName: string;
  amount?: number;
  systemDiskCategory?: string;
  systemDiskSize?: number;
  internetMaxBandwidthOut?: number;
  password?: string;
  userData?: string;
  dryRun?: boolean;
  tags?: Array<{ key: string; value: string }>;
}

export interface DescribeAliyunInstanceStatusInput {
  regionId: string;
  instanceIds: string[];
}

export interface DescribeAliyunInstancesInput {
  regionId: string;
  instanceIds: string[];
}

export interface RunAliyunInstancesResult {
  requestId: string;
  orderId?: string;
  tradePrice?: number;
  instanceIds: string[];
  dryRunPassed?: boolean;
}

export interface AliyunInstanceDetail {
  instanceId: string;
  instanceName?: string;
  status?: string;
  zoneId?: string;
  publicIpAddress: string[];
  privateIpAddress: string[];
}

export interface AliyunCloudAssistantStatus {
  instanceId: string;
  cloudAssistantStatus: string;
  cloudAssistantVersion?: string;
}

export interface AliyunRunCommandResult {
  commandId?: string;
  invokeId?: string;
  instanceId: string;
  invocationStatus?: string;
  invokeRecordStatus?: string;
  exitCode?: number;
  output?: string;
  errorCode?: string;
  errorInfo?: string;
}

@Injectable()
export class AliyunEcsService {
  private getTimeouts() {
    return {
      connectTimeout: Number(process.env.ALIYUN_ECS_CONNECT_TIMEOUT_MS ?? 10000),
      readTimeout: Number(process.env.ALIYUN_ECS_READ_TIMEOUT_MS ?? 30000),
    };
  }

  private createClient(regionId: string) {
    const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    const { connectTimeout, readTimeout } = this.getTimeouts();

    if (!accessKeyId || !accessKeySecret) {
      throw new InternalServerErrorException(
        "Aliyun credentials are missing. Set ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET.",
      );
    }

    const config = new Config({
      accessKeyId,
      accessKeySecret,
      endpoint: `ecs.${regionId}.aliyuncs.com`,
      connectTimeout,
      readTimeout,
    });

    return new Ecs20140526(config);
  }

  async runInstances(input: RunAliyunInstancesInput): Promise<RunAliyunInstancesResult> {
    const client = this.createClient(input.regionId);
    const { connectTimeout, readTimeout } = this.getTimeouts();
    const runtime = new RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: true,
      maxAttempts: 3,
    });

    const requestPayload: ConstructorParameters<typeof RunInstancesRequest>[0] = {
      regionId: input.regionId,
      imageId: input.imageId,
      instanceType: input.instanceType,
      securityGroupId: input.securityGroupId,
      vSwitchId: input.vSwitchId,
      instanceName: input.instanceName,
      amount: input.amount ?? 1,
      dryRun: input.dryRun ?? false,
      internetMaxBandwidthOut: input.internetMaxBandwidthOut ?? 0,
      password: input.password,
      userData: input.userData,
      tag: (input.tags ?? []).map((tag) => ({
        key: tag.key,
        value: tag.value,
      })),
    };

    if (input.systemDiskCategory || input.systemDiskSize) {
      requestPayload.systemDisk = {
        category: input.systemDiskCategory,
        size: input.systemDiskSize,
      };
    }

    const request = new RunInstancesRequest(requestPayload);

    try {
      const response = await client.runInstancesWithOptions(request, runtime);
      return this.normalizeRunInstancesResponse(response.body);
    } catch (error) {
      if (this.isDryRunPassedError(error)) {
        return {
          requestId: this.readErrorField(error, "requestId") ?? "",
          instanceIds: [],
          dryRunPassed: true,
        };
      }

      const message =
        error instanceof Error ? error.message : "Unknown Aliyun ECS error";
      throw new InternalServerErrorException(`Aliyun RunInstances failed: ${message}`);
    }
  }

  async describeInstanceStatuses(input: DescribeAliyunInstanceStatusInput) {
    const client = this.createClient(input.regionId);
    const { connectTimeout, readTimeout } = this.getTimeouts();
    const runtime = new RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: true,
      maxAttempts: 3,
    });
    const request = new DescribeInstanceStatusRequest({
      regionId: input.regionId,
      instanceId: input.instanceIds,
      pageSize: Math.min(input.instanceIds.length, 50),
      pageNumber: 1,
    });

    try {
      const response = await client.describeInstanceStatusWithOptions(request, runtime);
      return (
        response.body?.instanceStatuses?.instanceStatus?.map((item) => ({
          instanceId: item.instanceId ?? "",
          status: item.status ?? "Unknown",
        })) ?? []
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Aliyun ECS status error";
      throw new InternalServerErrorException(
        `Aliyun DescribeInstanceStatus failed: ${message}`,
      );
    }
  }

  async describeInstances(input: DescribeAliyunInstancesInput): Promise<AliyunInstanceDetail[]> {
    const client = this.createClient(input.regionId);
    const { connectTimeout, readTimeout } = this.getTimeouts();
    const runtime = new RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: true,
      maxAttempts: 3,
    });
    const request = new DescribeInstancesRequest({
      regionId: input.regionId,
      instanceIds: JSON.stringify(input.instanceIds),
      pageSize: Math.min(input.instanceIds.length, 100),
      pageNumber: 1,
    });

    try {
      const response = await client.describeInstancesWithOptions(request, runtime);
      return (
        response.body?.instances?.instance?.map((item) => ({
          instanceId: item.instanceId ?? "",
          instanceName: item.instanceName,
          status: item.status,
          zoneId: item.zoneId,
          publicIpAddress: item.publicIpAddress?.ipAddress ?? [],
          privateIpAddress: item.vpcAttributes?.privateIpAddress?.ipAddress ?? [],
        })) ?? []
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Aliyun ECS describe instances error";
      throw new InternalServerErrorException(`Aliyun DescribeInstances failed: ${message}`);
    }
  }

  async describeCloudAssistantStatuses(input: DescribeAliyunInstanceStatusInput): Promise<AliyunCloudAssistantStatus[]> {
    const client = this.createClient(input.regionId);
    const { connectTimeout, readTimeout } = this.getTimeouts();
    const runtime = new RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: true,
      maxAttempts: 3,
    });
    const request = new DescribeCloudAssistantStatusRequest({
      regionId: input.regionId,
      instanceId: input.instanceIds,
      OSType: "Linux",
    });

    try {
      const response = await client.describeCloudAssistantStatusWithOptions(request, runtime);
      return (
        response.body?.instanceCloudAssistantStatusSet?.instanceCloudAssistantStatus?.map((item) => ({
          instanceId: item.instanceId ?? "",
          cloudAssistantStatus: item.cloudAssistantStatus ?? "false",
          cloudAssistantVersion: item.cloudAssistantVersion,
        })) ?? []
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Aliyun Cloud Assistant status error";
      throw new InternalServerErrorException(
        `Aliyun DescribeCloudAssistantStatus failed: ${message}`,
      );
    }
  }

  async waitForCloudAssistantReady(
    input: DescribeAliyunInstanceStatusInput & { timeoutMs?: number; intervalMs?: number },
  ) {
    const timeoutMs = input.timeoutMs ?? 180000;
    const intervalMs = input.intervalMs ?? 5000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const statuses = await this.describeCloudAssistantStatuses(input);
      const allReady =
        statuses.length > 0 &&
        input.instanceIds.every((instanceId) =>
          statuses.some(
            (item) => item.instanceId === instanceId && item.cloudAssistantStatus === "true",
          ),
        );

      if (allReady) {
        return {
          success: true,
          statuses,
          waitedMs: Date.now() - startedAt,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      success: false,
      statuses: await this.describeCloudAssistantStatuses(input),
      waitedMs: Date.now() - startedAt,
    };
  }

  async runCommand(input: {
    regionId: string;
    instanceId: string;
    command: string;
    timeoutSeconds?: number;
  }): Promise<AliyunRunCommandResult> {
    const client = this.createClient(input.regionId);
    const { connectTimeout, readTimeout } = this.getTimeouts();
    const runtime = new RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: true,
      maxAttempts: 3,
    });
    const request = new RunCommandRequest({
      regionId: input.regionId,
      type: "RunShellScript",
      instanceId: [input.instanceId],
      contentEncoding: "Base64",
      commandContent: Buffer.from(input.command, "utf8").toString("base64"),
      keepCommand: false,
      timeout: input.timeoutSeconds ?? 60,
      workingDir: "/root",
      username: "root",
      repeatMode: "Once",
    });

    try {
      const response = await client.runCommandWithOptions(request, runtime);
      const invokeId = response.body?.invokeId;
      if (!invokeId) {
        throw new InternalServerErrorException("Aliyun RunCommand did not return invokeId.");
      }

      return await this.waitForInvocationResult({
        regionId: input.regionId,
        instanceId: input.instanceId,
        invokeId,
        commandId: response.body?.commandId,
        timeoutMs: (input.timeoutSeconds ?? 60) * 1000,
      });
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }

      const message =
        error instanceof Error ? error.message : "Unknown Aliyun RunCommand error";
      throw new InternalServerErrorException(`Aliyun RunCommand failed: ${message}`);
    }
  }

  async waitForRunning(input: DescribeAliyunInstanceStatusInput & { timeoutMs?: number; intervalMs?: number }) {
    const timeoutMs = input.timeoutMs ?? 180000;
    const intervalMs = input.intervalMs ?? 5000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const statuses = await this.describeInstanceStatuses(input);
      const allRunning =
        statuses.length > 0 &&
        input.instanceIds.every((instanceId) =>
          statuses.some((item) => item.instanceId === instanceId && item.status === "Running"),
        );

      if (allRunning) {
        return {
          success: true,
          statuses,
          waitedMs: Date.now() - startedAt,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      success: false,
      statuses: await this.describeInstanceStatuses(input),
      waitedMs: Date.now() - startedAt,
    };
  }

  private async waitForInvocationResult(input: {
    regionId: string;
    instanceId: string;
    invokeId: string;
    commandId?: string;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<AliyunRunCommandResult> {
    const timeoutMs = input.timeoutMs ?? 60000;
    const intervalMs = input.intervalMs ?? 3000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const result = await this.describeInvocationResult(input);
      if (
        result &&
        ["Success", "Failed", "Timeout", "Error", "Cancelled", "Terminated", "Aborted", "Invalid"].includes(
          result.invocationStatus ?? "",
        )
      ) {
        return result;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const result = await this.describeInvocationResult(input);
    if (result) {
      return result;
    }

    throw new InternalServerErrorException(
      `Aliyun DescribeInvocationResults timed out for invokeId ${input.invokeId}.`,
    );
  }

  private async describeInvocationResult(input: {
    regionId: string;
    instanceId: string;
    invokeId: string;
    commandId?: string;
  }): Promise<AliyunRunCommandResult | null> {
    const client = this.createClient(input.regionId);
    const { connectTimeout, readTimeout } = this.getTimeouts();
    const runtime = new RuntimeOptions({
      connectTimeout,
      readTimeout,
      autoretry: true,
      maxAttempts: 3,
    });
    const request = new DescribeInvocationResultsRequest({
      regionId: input.regionId,
      instanceId: input.instanceId,
      invokeId: input.invokeId,
      commandId: input.commandId,
      contentEncoding: "PlainText",
      maxResults: 10,
    });

    const response = await client.describeInvocationResultsWithOptions(request, runtime);
    const result = response.body?.invocation?.invocationResults?.invocationResult?.[0];
    if (!result) {
      return null;
    }

    return {
      commandId: result.commandId ?? input.commandId,
      invokeId: result.invokeId ?? input.invokeId,
      instanceId: result.instanceId ?? input.instanceId,
      invocationStatus: result.invocationStatus,
      invokeRecordStatus: result.invokeRecordStatus,
      exitCode: result.exitCode,
      output: result.output,
      errorCode: result.errorCode,
      errorInfo: result.errorInfo,
    };
  }

  private normalizeRunInstancesResponse(body: RunInstancesResponseBody | undefined): RunAliyunInstancesResult {
    return {
      requestId: body?.requestId ?? "",
      orderId: body?.orderId,
      tradePrice: body?.tradePrice,
      instanceIds: body?.instanceIdSets?.instanceIdSet ?? [],
    };
  }

  private isDryRunPassedError(error: unknown) {
    const code = this.readErrorField(error, "code");
    if (code === "DryRunOperation") {
      return true;
    }

    const message = error instanceof Error ? error.message : "";
    return message.includes("DryRunOperation");
  }

  private readErrorField(error: unknown, field: string) {
    if (!error || typeof error !== "object") {
      return undefined;
    }

    const record = error as Record<string, unknown>;
    const direct = record[field];
    if (typeof direct === "string") {
      return direct;
    }

    const data = record.data;
    if (data && typeof data === "object") {
      const nested = (data as Record<string, unknown>)[field];
      if (typeof nested === "string") {
        return nested;
      }
    }

    return undefined;
  }
}
