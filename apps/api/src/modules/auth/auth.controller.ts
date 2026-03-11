import { Body, Controller, Get, Patch } from "@nestjs/common";

import { StoreService } from "../store/store.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly storeService: StoreService) {}

  @Get("me")
  getMe() {
    const user = this.storeService.getCurrentUser();
    const workspaces = this.storeService.listWorkspaces();
    return {
      user,
      activeWorkspaceId: user.activeWorkspaceId,
      currentWorkspace: workspaces.find((item) => item.id === user.activeWorkspaceId) ?? null,
      workspaces,
    };
  }

  @Patch("workspace")
  async setCurrentWorkspace(@Body("workspaceId") workspaceId: string) {
    const user = await this.storeService.setCurrentWorkspace(workspaceId);
    const workspaces = this.storeService.listWorkspaces();

    return {
      user,
      activeWorkspaceId: user.activeWorkspaceId,
      currentWorkspace: workspaces.find((item) => item.id === user.activeWorkspaceId) ?? null,
      workspaces,
    };
  }
}
