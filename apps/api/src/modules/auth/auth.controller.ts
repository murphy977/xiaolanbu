import { Body, Controller, Get, Headers, Patch, Post, UnauthorizedException } from "@nestjs/common";

import { StoreService } from "../store/store.service";
import { UpdatePasswordDto } from "./dto/update-password.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly storeService: StoreService) {}

  @Get("me")
  async getMe(@Headers("x-xlb-session") sessionToken?: string) {
    const context = this.storeService.getAuthContext(sessionToken);
    if (!context) {
      throw new UnauthorizedException("请先登录");
    }

    await this.storeService.touchSession(sessionToken);
    return {
      user: context.user,
      activeWorkspaceId: context.user.activeWorkspaceId,
      currentWorkspace: context.currentWorkspace,
      currentWorkspaceRole: context.currentWorkspaceRole,
      workspaces: context.workspaces,
    };
  }

  @Post("register")
  async register(
    @Body("displayName") displayName: string,
    @Body("email") email: string,
    @Body("password") password: string,
  ) {
    return this.storeService.registerUser({
      displayName: displayName ?? "",
      email,
      password,
    });
  }

  @Post("login")
  async login(@Body("email") email: string, @Body("password") password: string) {
    return this.storeService.loginUser({ email, password });
  }

  @Post("logout")
  async logout(@Headers("x-xlb-session") sessionToken?: string) {
    await this.storeService.logoutSession(sessionToken);
    return { ok: true };
  }

  @Patch("workspace")
  async setCurrentWorkspace(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body("workspaceId") workspaceId: string,
  ) {
    const authUser = this.storeService.getUserBySessionToken(sessionToken);
    if (!authUser) {
      throw new UnauthorizedException("请先登录");
    }

    const user = await this.storeService.setCurrentWorkspaceForUser(authUser.id, workspaceId);
    const workspaceViews = this.storeService.listUserWorkspaceViews(authUser.id);

    return {
      user,
      activeWorkspaceId: user.activeWorkspaceId,
      currentWorkspace:
        workspaceViews.find((item) => item.id === user.activeWorkspaceId) ?? null,
      currentWorkspaceRole:
        this.storeService.getWorkspaceMembership(authUser.id, user.activeWorkspaceId)?.role ?? null,
      workspaces: workspaceViews,
    };
  }

  @Patch("profile")
  async updateProfile(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: UpdateProfileDto,
  ) {
    const authUser = this.storeService.getUserBySessionToken(sessionToken);
    if (!authUser) {
      throw new UnauthorizedException("请先登录");
    }

    return this.storeService.updateUserProfile({
      userId: authUser.id,
      displayName: body.displayName,
    });
  }

  @Patch("password")
  async updatePassword(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: UpdatePasswordDto,
  ) {
    const authUser = this.storeService.getUserBySessionToken(sessionToken);
    if (!authUser) {
      throw new UnauthorizedException("请先登录");
    }

    return this.storeService.updateUserPassword({
      userId: authUser.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
  }
}
