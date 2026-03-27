import { Controller, Get, Header } from "@nestjs/common";

import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Header("Content-Type", MetricsService.CONTENT_TYPE)
  async getMetrics() {
    return this.metricsService.render();
  }
}
