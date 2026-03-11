import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { StoreModule } from "../store/store.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";

@Module({
  imports: [StoreModule, InfrastructureModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
