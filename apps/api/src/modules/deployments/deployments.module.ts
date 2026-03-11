import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { DeploymentsController } from "./deployments.controller";
import { DeploymentsService } from "./deployments.service";

@Module({
  imports: [InfrastructureModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
})
export class DeploymentsModule {}
