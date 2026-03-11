import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";

import { CreateDeploymentDto } from "./dto/create-deployment.dto";
import { UpdateDeploymentStatusDto } from "./dto/update-deployment-status.dto";
import { DeploymentsService } from "./deployments.service";
import { StoreService } from "../store/store.service";

@Controller("deployments")
export class DeploymentsController {
  constructor(
    private readonly deploymentsService: DeploymentsService,
    private readonly storeService: StoreService,
  ) {}

  private requireUser(sessionToken?: string) {
    const user = this.storeService.getUserBySessionToken(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  @Get()
  listDeployments(
    @Query("workspaceId") workspaceId?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    return {
      items: this.storeService.listDeploymentsForUser(currentUser.id, workspaceId),
    };
  }

  @Post()
  async createDeployment(
    @Body() body: CreateDeploymentDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, body.workspaceId);
    return this.deploymentsService.createDeployment(body);
  }

  @Patch(":deploymentId/status")
  async updateDeploymentStatus(
    @Param("deploymentId") deploymentId: string,
    @Body() body: UpdateDeploymentStatusDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const deployment = this.storeService.getDeploymentForUser(currentUser.id, deploymentId);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, deployment.workspaceId);
    return {
      deployment: await this.deploymentsService.updateDeploymentStatus(deploymentId, body.status),
    };
  }

  @Post(":deploymentId/start")
  async startDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const deployment = this.storeService.getDeploymentForUser(currentUser.id, deploymentId);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.startDeployment(deploymentId);
  }

  @Post(":deploymentId/stop")
  async stopDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const deployment = this.storeService.getDeploymentForUser(currentUser.id, deploymentId);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.stopDeployment(deploymentId);
  }

  @Post(":deploymentId/restart")
  async restartDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const deployment = this.storeService.getDeploymentForUser(currentUser.id, deploymentId);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.restartDeployment(deploymentId);
  }

  @Delete(":deploymentId")
  async destroyDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const deployment = this.storeService.getDeploymentForUser(currentUser.id, deploymentId);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.destroyDeployment(deploymentId);
  }
}
