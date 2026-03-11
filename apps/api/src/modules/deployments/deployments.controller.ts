import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";

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
  updateDeploymentStatus(
    @Param("deploymentId") deploymentId: string,
    @Body() body: UpdateDeploymentStatusDto,
  ) {
    return {
      deployment: this.deploymentsService.updateDeploymentStatus(deploymentId, body.status),
    };
  }
}
