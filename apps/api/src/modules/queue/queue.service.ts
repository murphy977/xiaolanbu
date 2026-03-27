import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConnectionOptions, JobsOptions, Queue, QueueEvents } from "bullmq";
import IORedis, { Redis } from "ioredis";

import {
  BILLING_QUEUE_NAME,
  DEPLOYMENT_QUEUE_NAME,
} from "./queue.constants";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: Redis | null = null;
  private billingQueue: Queue | null = null;
  private deploymentQueue: Queue | null = null;
  private billingQueueEvents: QueueEvents | null = null;
  private deploymentQueueEvents: QueueEvents | null = null;

  isEnabled() {
    return Boolean(this.getRedisUrl());
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.billingQueueEvents?.close(),
      this.deploymentQueueEvents?.close(),
      this.billingQueue?.close(),
      this.deploymentQueue?.close(),
      this.connection?.quit(),
    ]);
    this.billingQueueEvents = null;
    this.deploymentQueueEvents = null;
    this.billingQueue = null;
    this.deploymentQueue = null;
    this.connection = null;
  }

  getRedisHealthSnapshot() {
    return {
      enabled: this.isEnabled(),
      workerMode: this.isWorkerMode(),
      redisUrlConfigured: Boolean(this.getRedisUrl()),
    };
  }

  async ping() {
    if (!this.isEnabled()) {
      return {
        ok: false,
        reason: "REDIS_URL is not configured",
      };
    }

    const connection = this.getConnection();
    const result = await connection.ping();
    return {
      ok: result === "PONG",
      response: result,
    };
  }

  async enqueueBillingJob<T = unknown>(
    name: string,
    data: Record<string, unknown>,
    options?: JobsOptions,
  ) {
    const queue = this.getBillingQueue();
    return queue.add(name, data, {
      removeOnComplete: 200,
      removeOnFail: 200,
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      ...options,
    });
  }

  async enqueueDeploymentJobAndWait<T = unknown>(
    name: string,
    data: Record<string, unknown>,
    options?: JobsOptions,
  ) {
    const queue = this.getDeploymentQueue();
    const job = await queue.add(name, data, {
      removeOnComplete: 200,
      removeOnFail: 200,
      attempts: 1,
      ...options,
    });
    const events = this.getDeploymentQueueEvents();
    const timeoutMs = this.readDeploymentJobTimeoutMs();
    return (await job.waitUntilFinished(events, timeoutMs)) as T;
  }

  async enqueueBillingJobIfIdle(
    name: string,
    data: Record<string, unknown>,
    jobId: string,
    options?: JobsOptions,
  ) {
    try {
      return await this.enqueueBillingJob(name, data, {
        jobId,
        ...options,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Job is already waiting") || message.includes("JobId")) {
        this.logger.debug(`Skipped duplicate billing job enqueue for ${jobId}`);
        return null;
      }
      throw error;
    }
  }

  getWorkerOptions(): ConnectionOptions {
    return this.getConnectionOptions();
  }

  isWorkerMode() {
    return process.env.XLB_JOB_WORKER_MODE === "true";
  }

  private getRedisUrl() {
    return process.env.REDIS_URL?.trim() || process.env.XLB_REDIS_URL?.trim() || "";
  }

  private getConnection() {
    if (!this.connection) {
      const redisUrl = this.getRedisUrl();
      if (!redisUrl) {
        throw new Error("REDIS_URL is not configured");
      }
      this.connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
      });
    }
    return this.connection;
  }

  private getConnectionOptions(): ConnectionOptions {
    const redisUrl = this.getRedisUrl();
    if (!redisUrl) {
      throw new Error("REDIS_URL is not configured");
    }

    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) || 0 : 0,
      tls: parsed.protocol === "rediss:" ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    };
  }

  private getBillingQueue() {
    if (!this.billingQueue) {
      this.billingQueue = new Queue(BILLING_QUEUE_NAME, {
        connection: this.getConnectionOptions(),
        defaultJobOptions: {
          removeOnComplete: 200,
          removeOnFail: 200,
        },
      });
    }
    return this.billingQueue;
  }

  private getDeploymentQueue() {
    if (!this.deploymentQueue) {
      this.deploymentQueue = new Queue(DEPLOYMENT_QUEUE_NAME, {
        connection: this.getConnectionOptions(),
        defaultJobOptions: {
          removeOnComplete: 200,
          removeOnFail: 200,
        },
      });
    }
    return this.deploymentQueue;
  }

  private getDeploymentQueueEvents() {
    if (!this.deploymentQueueEvents) {
      this.deploymentQueueEvents = new QueueEvents(DEPLOYMENT_QUEUE_NAME, {
        connection: this.getConnectionOptions(),
      });
    }
    return this.deploymentQueueEvents;
  }

  private readDeploymentJobTimeoutMs() {
    const value = Number(process.env.XLB_DEPLOYMENT_JOB_TIMEOUT_MS ?? "900000");
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 900000;
  }
}
