import { Module } from "@nestjs/common";

import { BillingJobWorker } from "./modules/billing/billing-job.worker";
import { BillingService } from "./modules/billing/billing.service";
import { DeploymentJobWorker } from "./modules/deployments/deployment-job.worker";
import { DeploymentsService } from "./modules/deployments/deployments.service";
import { InfrastructureModule } from "./modules/infrastructure/infrastructure.module";
import { QueueModule } from "./modules/queue/queue.module";
import { RuntimeModule } from "./modules/runtime/runtime.module";
import { StoreModule } from "./modules/store/store.module";

@Module({
  imports: [StoreModule, InfrastructureModule, RuntimeModule, QueueModule],
  providers: [BillingService, DeploymentsService, BillingJobWorker, DeploymentJobWorker],
})
export class WorkerModule {}
