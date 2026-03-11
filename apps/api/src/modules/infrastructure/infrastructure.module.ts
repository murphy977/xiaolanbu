import { Module } from "@nestjs/common";

import { AliyunEcsService } from "./services/aliyun-ecs.service";

@Module({
  providers: [AliyunEcsService],
  exports: [AliyunEcsService],
})
export class InfrastructureModule {}
