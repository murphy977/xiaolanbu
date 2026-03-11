import { Controller, Get, Param } from "@nestjs/common";

import { StoreService } from "../store/store.service";

@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly storeService: StoreService) {}

  @Get()
  listWorkspaces() {
    const currentUser = this.storeService.getCurrentUser();
    return {
      activeWorkspaceId: currentUser.activeWorkspaceId,
      items: this.storeService.listWorkspaces(),
    };
  }

  @Get(":workspaceId")
  getWorkspace(@Param("workspaceId") workspaceId: string) {
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
