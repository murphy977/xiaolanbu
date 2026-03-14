import { Module } from "@nestjs/common";

import { AuthModule } from "./modules/auth/auth.module";
import { BillingModule } from "./modules/billing/billing.module";
import { DeploymentsModule } from "./modules/deployments/deployments.module";
import { HealthModule } from "./modules/health/health.module";
import { InfrastructureModule } from "./modules/infrastructure/infrastructure.module";
import { RuntimeModule } from "./modules/runtime/runtime.module";
import { StoreModule } from "./modules/store/store.module";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module";

@Module({
  imports: [
    StoreModule,
    InfrastructureModule,
    RuntimeModule,
    HealthModule,
    AuthModule,
    WorkspacesModule,
    DeploymentsModule,
    BillingModule,
  ],
})
export class AppModule {}
