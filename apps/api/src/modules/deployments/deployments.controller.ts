import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";

import { CreateDeploymentDto } from "./dto/create-deployment.dto";
import { UpdateDeploymentStatusDto } from "./dto/update-deployment-status.dto";
import { DeploymentsService } from "./deployments.service";

@Controller("deployments")
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @Get()
  listDeployments(@Query("workspaceId") workspaceId?: string) {
    return {
      items: this.deploymentsService.listDeployments(workspaceId),
    };
  }

  @Post()
  async createDeployment(@Body() body: CreateDeploymentDto) {
    return this.deploymentsService.createDeployment(body);
  }

  @Patch(":deploymentId/status")
  async updateDeploymentStatus(
    @Param("deploymentId") deploymentId: string,
    @Body() body: UpdateDeploymentStatusDto,
  ) {
    return {
      deployment: await this.deploymentsService.updateDeploymentStatus(deploymentId, body.status),
    };
  }

  @Post(":deploymentId/start")
  async startDeployment(@Param("deploymentId") deploymentId: string) {
    return this.deploymentsService.startDeployment(deploymentId);
  }

  @Post(":deploymentId/stop")
  async stopDeployment(@Param("deploymentId") deploymentId: string) {
    return this.deploymentsService.stopDeployment(deploymentId);
  }

  @Post(":deploymentId/restart")
  async restartDeployment(@Param("deploymentId") deploymentId: string) {
    return this.deploymentsService.restartDeployment(deploymentId);
  }

  @Delete(":deploymentId")
  async destroyDeployment(@Param("deploymentId") deploymentId: string) {
    return this.deploymentsService.destroyDeployment(deploymentId);
  }
}
