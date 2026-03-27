import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";

import { CreateDeploymentDto } from "./dto/create-deployment.dto";
import { SyncLocalRuntimeDto } from "./dto/sync-local-runtime.dto";
import { UpdateDeploymentModelDto } from "./dto/update-deployment-model.dto";
import { UpdateDeploymentStatusDto } from "./dto/update-deployment-status.dto";
import { DeploymentsService } from "./deployments.service";
import { StoreService } from "../store/store.service";

@Controller("deployments")
export class DeploymentsController {
  constructor(
    private readonly deploymentsService: DeploymentsService,
    private readonly storeService: StoreService,
  ) {}

  private async requireUser(sessionToken?: string) {
    const user = await this.storeService.getUserBySessionTokenAsync(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  @Get()
  async listDeployments(
    @Query("accountScopeId") accountScopeId?: string,
    @Query("workspaceId") workspaceId?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const resolvedScopeId = accountScopeId?.trim() || workspaceId?.trim() || undefined;
    return {
      items: await this.deploymentsService.listDeploymentsForUser(currentUser.id, resolvedScopeId),
    };
  }

  @Get("model-catalog")
  async getModelCatalog(@Headers("x-xlb-session") sessionToken?: string) {
    await this.requireUser(sessionToken);
    return {
      items: this.deploymentsService.getGatewayModelCatalog(),
    };
  }

  @Post()
  async createDeployment(
    @Body() body: CreateDeploymentDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    if (body.mode === "local") {
      throw new GoneException("本地 deployment 路径已废弃，请升级客户端并改用 /v1/runtime/local/bootstrap。");
    }

    const currentUser = await this.requireUser(sessionToken);
    const workspaceId =
      body.accountScopeId?.trim() ||
      body.workspaceId?.trim() ||
      (await this.storeService.getPreferredWorkspaceIdForUserAsync(currentUser.id));
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, workspaceId);
    return this.deploymentsService.createDeployment({
      ...body,
      workspaceId,
    });
  }

  @Patch(":deploymentId/status")
  async updateDeploymentStatus(
    @Param("deploymentId") deploymentId: string,
    @Body() body: UpdateDeploymentStatusDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return {
      deployment: await this.deploymentsService.updateDeploymentStatus(deploymentId, body.status),
    };
  }

  @Post(":deploymentId/start")
  async startDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.startDeployment(deploymentId);
  }

  @Post(":deploymentId/stop")
  async stopDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.stopDeployment(deploymentId);
  }

  @Post(":deploymentId/restart")
  async restartDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.restartDeployment(deploymentId);
  }

  @Patch(":deploymentId/model")
  async updateDeploymentModel(
    @Param("deploymentId") deploymentId: string,
    @Body() body: UpdateDeploymentModelDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.updateDeploymentModel(deploymentId, body.modelId);
  }

  @Post(":deploymentId/refresh-native-responses")
  async refreshDeploymentNativeResponses(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.refreshDeploymentNativeResponses(deploymentId);
  }

  @Post("refresh-native-responses")
  async refreshNativeResponsesForScope(
    @Body() body: { accountScopeId?: string; workspaceId?: string } = {},
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const resolvedScopeId =
      body.accountScopeId?.trim() ||
      body.workspaceId?.trim() ||
      (await this.storeService.getPreferredWorkspaceIdForUserAsync(currentUser.id));
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, resolvedScopeId);
    const deployments = (await this.storeService.listDeploymentsForUserAsync(currentUser.id, resolvedScopeId))
      .filter((item) => item.mode === "cloud" && item.provider === "aliyun");

    return this.deploymentsService.refreshNativeResponsesForDeployments(
      deployments.map((item) => item.id),
    );
  }

  @Post(":deploymentId/local-bootstrap")
  async getLocalDeploymentBootstrap(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    await this.requireUser(sessionToken);
    throw new GoneException("本地 deployment bootstrap 已废弃，请升级客户端并改用 /v1/runtime/local/bootstrap。");
  }

  @Post(":deploymentId/local-runtime-sync")
  async syncLocalDeploymentRuntime(
    @Param("deploymentId") deploymentId: string,
    @Body() body: SyncLocalRuntimeDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    await this.requireUser(sessionToken);
    void deploymentId;
    void body;
    throw new GoneException("本地 deployment runtime sync 已废弃，请升级客户端并改用 /v1/runtime/local/bootstrap。");
  }

  @Delete(":deploymentId")
  async destroyDeployment(
    @Param("deploymentId") deploymentId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const deployment = await this.storeService.getDeploymentForUserAsync(currentUser.id, deploymentId);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, deployment.workspaceId);
    return this.deploymentsService.destroyDeployment(deploymentId);
  }
}
