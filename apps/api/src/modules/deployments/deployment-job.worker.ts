import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";

import {
  DEPLOYMENT_CREATE_JOB,
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_LOCAL_BOOTSTRAP_JOB,
  DEPLOYMENT_QUEUE_NAME,
  DEPLOYMENT_REFRESH_NATIVE_RESPONSES_JOB,
  DEPLOYMENT_RESTART_JOB,
  DEPLOYMENT_START_JOB,
  DEPLOYMENT_STOP_JOB,
  DEPLOYMENT_UPDATE_STATUS_JOB,
} from "../queue/queue.constants";
import { QueueService } from "../queue/queue.service";
import { DeploymentsService } from "./deployments.service";

@Injectable()
export class DeploymentJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeploymentJobWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly queueService: QueueService,
    private readonly deploymentsService: DeploymentsService,
  ) {}

  onModuleInit() {
    if (!this.queueService.isEnabled() || !this.queueService.isWorkerMode()) {
      return;
    }

    this.worker = new Worker(
      DEPLOYMENT_QUEUE_NAME,
      async (job) => this.handleJob(job),
      {
        connection: this.queueService.getWorkerOptions(),
        concurrency: this.readConcurrency(),
      },
    );
    this.worker.on("completed", (job) => {
      this.logger.debug(`deployment job completed id=${job.id} name=${job.name}`);
    });
    this.worker.on("failed", (job, error) => {
      this.logger.error(
        `deployment job failed id=${job?.id ?? "unknown"} name=${job?.name ?? "unknown"}: ${error.message}`,
      );
    });

    this.logger.log(`Deployment worker started. concurrency=${this.readConcurrency()}`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
    this.worker = null;
  }

  private async handleJob(job: Job) {
    switch (job.name) {
      case DEPLOYMENT_CREATE_JOB:
        return this.deploymentsService.createDeployment(job.data as any);
      case DEPLOYMENT_UPDATE_STATUS_JOB:
        return this.deploymentsService.updateDeploymentStatus(
          String(job.data.deploymentId ?? ""),
          job.data.status as any,
        );
      case DEPLOYMENT_START_JOB:
        return this.deploymentsService.startDeployment(String(job.data.deploymentId ?? ""));
      case DEPLOYMENT_STOP_JOB:
        return this.deploymentsService.stopDeployment(String(job.data.deploymentId ?? ""));
      case DEPLOYMENT_RESTART_JOB:
        return this.deploymentsService.restartDeployment(String(job.data.deploymentId ?? ""));
      case DEPLOYMENT_REFRESH_NATIVE_RESPONSES_JOB:
        return this.deploymentsService.refreshDeploymentNativeResponses(
          String(job.data.deploymentId ?? ""),
        );
      case DEPLOYMENT_DESTROY_JOB:
        return this.deploymentsService.destroyDeployment(String(job.data.deploymentId ?? ""));
      case DEPLOYMENT_LOCAL_BOOTSTRAP_JOB:
        return this.deploymentsService.getLocalDeploymentBootstrap(String(job.data.deploymentId ?? ""));
      default:
        throw new Error(`Unsupported deployment job: ${job.name}`);
    }
  }

  private readConcurrency() {
    const value = Number(process.env.XLB_DEPLOYMENT_JOB_CONCURRENCY ?? "8");
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 8;
  }
}
