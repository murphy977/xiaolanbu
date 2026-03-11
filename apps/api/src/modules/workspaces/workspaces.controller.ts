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
import { UpdateWorkspaceMemberDto } from "./dto/update-workspace-member.dto";

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

  @Get(":workspaceId/members")
  listWorkspaceMembers(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);

    return {
      items: this.storeService.listWorkspaceMembers(workspaceId),
      currentUserRole:
        this.storeService.getWorkspaceMembership(currentUser.id, workspaceId)?.role ?? null,
    };
  }

  @Post(":workspaceId/members")
  async addWorkspaceMember(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: AddWorkspaceMemberDto,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const items = await this.storeService.addWorkspaceMemberByEmail({
      currentUserId: currentUser.id,
      workspaceId,
      email: body.email,
      role: body.role,
    });

    return {
      items,
      currentUserRole:
        this.storeService.getWorkspaceMembership(currentUser.id, workspaceId)?.role ?? null,
    };
  }

  @Patch(":workspaceId/members/:memberId")
  async updateWorkspaceMember(
    @Param("workspaceId") workspaceId: string,
    @Param("memberId") memberId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: UpdateWorkspaceMemberDto,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const items = await this.storeService.updateWorkspaceMemberRole({
      currentUserId: currentUser.id,
      workspaceId,
      memberId,
      role: body.role,
    });

    return {
      items,
      currentUserRole:
        this.storeService.getWorkspaceMembership(currentUser.id, workspaceId)?.role ?? null,
    };
  }

  @Delete(":workspaceId/members/:memberId")
  async removeWorkspaceMember(
    @Param("workspaceId") workspaceId: string,
    @Param("memberId") memberId: string,
    @Headers("x-xlb-session") sessionToken: string | undefined,
  ) {
    const currentUser = this.requireUser(sessionToken);
    const items = await this.storeService.removeWorkspaceMember({
      currentUserId: currentUser.id,
      workspaceId,
      memberId,
    });

    return {
      items,
      currentUserRole:
        this.storeService.getWorkspaceMembership(currentUser.id, workspaceId)?.role ?? null,
    };
  }
}
