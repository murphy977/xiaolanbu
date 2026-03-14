import { Module } from "@nestjs/common";

import { LiteLlmCompatController } from "./litellm-compat.controller";
import { AliyunEcsService } from "./services/aliyun-ecs.service";
import { LiteLlmProxyService } from "./services/litellm-proxy.service";

@Module({
  controllers: [LiteLlmCompatController],
  providers: [AliyunEcsService, LiteLlmProxyService],
  exports: [AliyunEcsService, LiteLlmProxyService],
})
export class InfrastructureModule {}
