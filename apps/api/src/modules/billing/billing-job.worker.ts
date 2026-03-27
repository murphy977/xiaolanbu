import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";

import { QueueService } from "../queue/queue.service";
import { BILLING_QUEUE_NAME, BILLING_SYNC_USER_JOB } from "../queue/queue.constants";
import { BillingService } from "./billing.service";

@Injectable()
export class BillingJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingJobWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly queueService: QueueService,
    private readonly billingService: BillingService,
  ) {}

  onModuleInit() {
    if (!this.queueService.isEnabled() || !this.queueService.isWorkerMode()) {
      return;
    }

    this.worker = new Worker(
      BILLING_QUEUE_NAME,
      async (job) => this.handleJob(job),
      {
        connection: this.queueService.getWorkerOptions(),
        concurrency: this.readConcurrency(),
      },
    );
    this.worker.on("completed", (job) => {
      this.logger.debug(`billing job completed id=${job.id} name=${job.name}`);
    });
    this.worker.on("failed", (job, error) => {
      this.logger.error(
        `billing job failed id=${job?.id ?? "unknown"} name=${job?.name ?? "unknown"}: ${error.message}`,
      );
    });

    this.logger.log(`Billing worker started. concurrency=${this.readConcurrency()}`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
    this.worker = null;
  }

  private async handleJob(job: Job) {
    if (job.name === BILLING_SYNC_USER_JOB) {
      return this.billingService.syncUserUsage({
        userId: String(job.data.userId ?? ""),
        limit:
          typeof job.data.limit === "number"
            ? job.data.limit
            : Number(job.data.limit ?? 0) || undefined,
      });
    }

    throw new Error(`Unsupported billing job: ${job.name}`);
  }

  private readConcurrency() {
    const value = Number(process.env.XLB_BILLING_JOB_CONCURRENCY ?? "20");
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
  }
}
