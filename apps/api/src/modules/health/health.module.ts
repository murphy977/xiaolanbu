import { Module } from "@nestjs/common";

import { StoreModule } from "../store/store.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [StoreModule],
  controllers: [HealthController],
})
export class HealthModule {}
