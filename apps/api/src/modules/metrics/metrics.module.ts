import { Module } from "@nestjs/common";

import { QueueModule } from "../queue/queue.module";
import { StoreModule } from "../store/store.module";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

@Module({
  imports: [StoreModule, QueueModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
