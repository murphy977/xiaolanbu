import { Body, Controller, Get, Header, Headers, Patch, Post, UnauthorizedException } from "@nestjs/common";

import { StoreService } from "../store/store.service";
import { UpdatePasswordDto } from "./dto/update-password.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly storeService: StoreService) {}

  private async buildAccountScopeResponse(userId: string, user: { activeWorkspaceId: string }) {
    const scopeViews = await this.storeService.listUserWorkspaceViewsAsync(userId);
    const accountScopeId = user.activeWorkspaceId;
    const currentAccountScope =
      scopeViews.find((item) => item.id === accountScopeId) ?? null;
    const currentAccountRole =
      (await this.storeService.getWorkspaceMembershipAsync(userId, accountScopeId))?.role ?? null;

    return {
      user,
      billingUserId: userId,
      accountScopeId,
      defaultScopeId: accountScopeId,
      currentAccountScope,
      currentAccountRole,
      accountScopes: scopeViews,
      activeWorkspaceId: accountScopeId,
      currentWorkspace: currentAccountScope,
      currentWorkspaceRole: currentAccountRole,
      workspaces: scopeViews,
    };
  }

  @Get("me")
  async getMe(@Headers("x-xlb-session") sessionToken?: string) {
    const context = await this.storeService.getAuthContextAsync(sessionToken);
    if (!context) {
      throw new UnauthorizedException("请先登录");
    }

    await this.storeService.touchSession(sessionToken);
    return context;
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

  // Legacy compatibility route. New clients should use PATCH /auth/account-scope.
  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Patch("workspace")
  async setCurrentWorkspace(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body("workspaceId") workspaceId: string,
    @Body("accountScopeId") accountScopeId: string | undefined,
  ) {
    const authUser = await this.storeService.getUserBySessionTokenAsync(sessionToken);
    if (!authUser) {
      throw new UnauthorizedException("请先登录");
    }

    const resolvedScopeId =
      accountScopeId?.trim() ||
      workspaceId?.trim() ||
      (await this.storeService.getPreferredWorkspaceIdForUserAsync(authUser.id));
    const user = await this.storeService.setCurrentWorkspaceForUser(authUser.id, resolvedScopeId);

    return this.buildAccountScopeResponse(authUser.id, user);
  }

  @Patch("account-scope")
  async setCurrentAccountScope(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body("accountScopeId") accountScopeId: string,
    @Body("workspaceId") workspaceId: string | undefined,
  ) {
    const authUser = await this.storeService.getUserBySessionTokenAsync(sessionToken);
    if (!authUser) {
      throw new UnauthorizedException("请先登录");
    }

    const resolvedScopeId =
      accountScopeId?.trim() ||
      workspaceId?.trim() ||
      (await this.storeService.getPreferredWorkspaceIdForUserAsync(authUser.id));
    const user = await this.storeService.setCurrentWorkspaceForUser(authUser.id, resolvedScopeId);

    return this.buildAccountScopeResponse(authUser.id, user);
  }

  @Patch("profile")
  async updateProfile(
    @Headers("x-xlb-session") sessionToken: string | undefined,
    @Body() body: UpdateProfileDto,
  ) {
    const authUser = await this.storeService.getUserBySessionTokenAsync(sessionToken);
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
    const authUser = await this.storeService.getUserBySessionTokenAsync(sessionToken);
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
