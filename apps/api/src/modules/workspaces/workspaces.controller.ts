import { Controller, Get, Headers, Param, UnauthorizedException } from "@nestjs/common";

import { StoreService } from "../store/store.service";

@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly storeService: StoreService) {}

  private requireUser(sessionToken?: string) {
    const user = this.storeService.getUserBySessionToken(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  @Get()
  listWorkspaces(@Headers("x-xlb-session") sessionToken?: string) {
    const currentUser = this.requireUser(sessionToken);
    return {
      activeWorkspaceId: currentUser.activeWorkspaceId,
      items: this.storeService.listUserWorkspaces(currentUser.id),
    };
  }

  @Get(":workspaceId")
  getWorkspace(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    const workspace = this.storeService.getWorkspace(workspaceId);
    const wallet = this.storeService.getWallet(workspaceId);
    const deployments = this.storeService.listDeployments(workspaceId);

    return {
      workspace,
      wallet,
      deployments,
    };
  }
}
