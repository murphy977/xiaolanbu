import { Module } from "@nestjs/common";

import { AliyunEcsService } from "./services/aliyun-ecs.service";
import { LiteLlmProxyService } from "./services/litellm-proxy.service";

@Module({
  providers: [AliyunEcsService, LiteLlmProxyService],
  exports: [AliyunEcsService, LiteLlmProxyService],
})
export class InfrastructureModule {}
