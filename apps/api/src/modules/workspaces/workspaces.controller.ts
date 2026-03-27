import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from "@nestjs/common";

import { StoreService } from "../store/store.service";
import { AddWorkspaceMemberDto } from "./dto/add-workspace-member.dto";
import { CreateWorkspaceDto } from "./dto/create-workspace.dto";
import { UpdateWorkspaceMemberDto } from "./dto/update-workspace-member.dto";
import { UpdateWorkspaceDto } from "./dto/update-workspace.dto";

@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly storeService: StoreService) {}

  private async requireUser(sessionToken?: string) {
    const user = await this.storeService.getUserBySessionTokenAsync(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  @Get()
  async listWorkspaces(@Headers("x-xlb-session") sessionToken?: string) {
    const currentUser = await this.requireUser(sessionToken);
    return {
      activeWorkspaceId: currentUser.activeWorkspaceId,
      items: await this.storeService.listUserWorkspacesAsync(currentUser.id),
    };
  }

  @Post()
  async createWorkspace(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: CreateWorkspaceDto,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    return this.storeService.createWorkspaceForUser({
      userId: currentUser.id,
      name: body.name,
    });
  }

  @Get(":workspaceId")
  async getWorkspace(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    const [workspace, wallet, deployments] = await Promise.all([
      this.storeService.getWorkspaceAsync(workspaceId),
      this.storeService.getWalletAsync(workspaceId),
      this.storeService.listDeploymentsAsync(workspaceId),
    ]);

    return {
      workspace,
      wallet,
      deployments,
    };
  }

  @Patch(":workspaceId")
  async updateWorkspace(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: UpdateWorkspaceDto,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    return this.storeService.updateWorkspaceName({
      currentUserId: currentUser.id,
      workspaceId,
      name: body.name,
    });
  }

  @Post(":workspaceId/leave")
  async leaveWorkspace(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    return this.storeService.leaveWorkspace({
      currentUserId: currentUser.id,
      workspaceId,
    });
  }

  @Post(":workspaceId/archive")
  async archiveWorkspace(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    return this.storeService.archiveWorkspace({
      currentUserId: currentUser.id,
      workspaceId,
    });
  }

  @Get(":workspaceId/members")
  async listWorkspaceMembers(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);

    return {
      items: await this.storeService.listWorkspaceMembersAsync(workspaceId),
      currentUserRole:
        (await this.storeService.getWorkspaceMembershipAsync(currentUser.id, workspaceId))?.role ?? null,
    };
  }

  @Post(":workspaceId/members")
  async addWorkspaceMember(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: AddWorkspaceMemberDto,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const items = await this.storeService.addWorkspaceMemberByEmail({
      currentUserId: currentUser.id,
      workspaceId,
      email: body.email,
      role: body.role,
    });

    return {
      items,
      currentUserRole:
        (await this.storeService.getWorkspaceMembershipAsync(currentUser.id, workspaceId))?.role ?? null,
    };
  }

  @Patch(":workspaceId/members/:memberId")
  async updateWorkspaceMember(
    @Param("workspaceId") workspaceId: string,
    @Param("memberId") memberId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: UpdateWorkspaceMemberDto,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const items = await this.storeService.updateWorkspaceMemberRole({
      currentUserId: currentUser.id,
      workspaceId,
      memberId,
      role: body.role,
    });

    return {
      items,
      currentUserRole:
        (await this.storeService.getWorkspaceMembershipAsync(currentUser.id, workspaceId))?.role ?? null,
    };
  }

  @Delete(":workspaceId/members/:memberId")
  async removeWorkspaceMember(
    @Param("workspaceId") workspaceId: string,
    @Param("memberId") memberId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    const items = await this.storeService.removeWorkspaceMember({
      currentUserId: currentUser.id,
      workspaceId,
      memberId,
    });

    return {
      items,
      currentUserRole:
        (await this.storeService.getWorkspaceMembershipAsync(currentUser.id, workspaceId))?.role ?? null,
    };
  }
}
