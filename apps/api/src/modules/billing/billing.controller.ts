import { Body, Controller, Get, Header, Headers, Param, Post, Query, UnauthorizedException } from "@nestjs/common";

import { BillingService } from "./billing.service";
import { StoreService } from "../store/store.service";
import {
  CreateWalletAdjustmentDto,
  CreateWalletTopupDto,
} from "./dto/create-wallet-transaction.dto";

@Controller("billing")
export class BillingController {
  constructor(
    private readonly storeService: StoreService,
    private readonly billingService: BillingService,
  ) {}

  private async requireUser(sessionToken?: string) {
    const user = await this.storeService.getUserBySessionTokenAsync(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  private async requireBillingScope(sessionToken?: string) {
    const user = await this.requireUser(sessionToken);
    const accountScopeId = await this.storeService.getPreferredWorkspaceIdForUserAsync(user.id);
    if (!accountScopeId) {
      throw new UnauthorizedException("当前账号尚未绑定默认计费归属");
    }
    return {
      user,
      accountScopeId,
      workspaceId: accountScopeId,
    };
  }

  // Account-first billing routes used by the desktop product path.
  @Get("me/wallet")
  async getMyWallet(@Headers("x-xlb-session") sessionToken?: string) {
    const { user } = await this.requireBillingScope(sessionToken);
    return {
      wallet: await this.storeService.getWalletByUserIdAsync(user.id),
    };
  }

  @Get("account/wallet")
  async getAccountWallet(@Headers("x-xlb-session") sessionToken?: string) {
    return this.getMyWallet(sessionToken);
  }

  @Get("me/usage")
  async getMyUsageSummary(
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    return this.billingService.getUserUsageSummaryWithLocal(user.id, period ?? "today");
  }

  @Get("account/usage")
  async getAccountUsageSummary(
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.getMyUsageSummary(period, sessionToken);
  }

  @Get("me/deployments/summary")
  async listMyDeploymentUsageSummaries(
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    return {
      items: await this.storeService.listDeploymentUsageSummariesByUserIdAsync(user.id, period ?? "today"),
    };
  }

  @Get("account/deployments/summary")
  async listAccountDeploymentUsageSummaries(
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.listMyDeploymentUsageSummaries(period, sessionToken);
  }

  @Get("me/feed")
  async listMyBillingFeed(@Headers("x-xlb-session") sessionToken?: string) {
    const { user } = await this.requireBillingScope(sessionToken);
    return {
      items: await this.storeService.listBillingFeedByUserIdAsync(user.id),
    };
  }

  @Get("account/feed")
  async listAccountBillingFeed(@Headers("x-xlb-session") sessionToken?: string) {
    return this.listMyBillingFeed(sessionToken);
  }

  @Get("me/ledger")
  async listMyUsageLedger(
    @Query("deploymentId") deploymentId?: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    const parsedLimit = limit ? Number(limit) : undefined;
    return {
      items: await this.storeService.listUsageLedgerByUserIdAsync(user.id, {
        deploymentId,
        limit:
          typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? parsedLimit
            : 50,
      }),
    };
  }

  @Get("account/ledger")
  async listAccountUsageLedger(
    @Query("deploymentId") deploymentId?: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.listMyUsageLedger(deploymentId, limit, sessionToken);
  }

  @Get("me/transactions")
  async listMyWalletTransactions(
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    const parsedLimit = limit ? Number(limit) : undefined;
    return {
      items: await this.storeService.listWalletTransactionsByUserIdAsync(
        user.id,
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : 50,
      ),
    };
  }

  @Get("account/transactions")
  async listAccountWalletTransactions(
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.listMyWalletTransactions(limit, sessionToken);
  }

  @Post("me/sync")
  async syncMyUsage(
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.billingService.syncUserUsage({
      userId: user.id,
      limit:
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : 100,
    });
  }

  @Post("account/sync")
  async syncAccountUsage(
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.syncMyUsage(limit, sessionToken);
  }

  @Post("me/topups")
  async createMyWalletTopup(
    @Body() body: CreateWalletTopupDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    return this.billingService.createWalletTopupForUser({
      userId: user.id,
      amountCny: body.amountCny,
      title: body.title,
    });
  }

  @Post("account/topups")
  async createAccountWalletTopup(
    @Body() body: CreateWalletTopupDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.createMyWalletTopup(body, sessionToken);
  }

  @Post("me/adjustments")
  async createMyWalletAdjustment(
    @Body() body: CreateWalletAdjustmentDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const { user } = await this.requireBillingScope(sessionToken);
    return this.billingService.createWalletAdjustmentForUser({
      userId: user.id,
      amountCny: body.amountCny,
      title: body.title,
    });
  }

  @Post("account/adjustments")
  async createAccountWalletAdjustment(
    @Body() body: CreateWalletAdjustmentDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    return this.createMyWalletAdjustment(body, sessionToken);
  }

  @Post("me/reconcile")
  async reconcileMyGatewayBudgets(@Headers("x-xlb-session") sessionToken?: string) {
    const { user } = await this.requireBillingScope(sessionToken);
    return this.billingService.reconcileUserGatewayBudgets(user.id);
  }

  @Post("account/reconcile")
  async reconcileAccountGatewayBudgets(@Headers("x-xlb-session") sessionToken?: string) {
    return this.reconcileMyGatewayBudgets(sessionToken);
  }

  // Legacy workspace-scoped compatibility routes.
  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Get("workspaces/:workspaceId/wallet")
  async getWallet(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    return {
      wallet: await this.storeService.getWalletAsync(workspaceId),
    };
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Get("workspaces/:workspaceId/usage")
  async getUsageSummary(
    @Param("workspaceId") workspaceId: string,
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    return {
      summary: await this.storeService.getUsageSummaryAsync(workspaceId, period ?? "today"),
    };
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Get("workspaces/:workspaceId/deployments/summary")
  async listDeploymentUsageSummaries(
    @Param("workspaceId") workspaceId: string,
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    return {
      items: await this.billingService.listDeploymentUsageSummaries(workspaceId, period ?? "today"),
    };
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Get("workspaces/:workspaceId/feed")
  async listBillingFeed(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    return {
      items: await this.storeService.listBillingFeedAsync(workspaceId),
    };
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Get("workspaces/:workspaceId/ledger")
  async listUsageLedger(
    @Param("workspaceId") workspaceId: string,
    @Query("deploymentId") deploymentId?: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    const parsedLimit = limit ? Number(limit) : undefined;
    return {
      items: await this.billingService.listUsageLedger(workspaceId, {
        deploymentId,
        limit:
          typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? parsedLimit
            : 50,
      }),
    };
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Get("workspaces/:workspaceId/transactions")
  async listWalletTransactions(
    @Param("workspaceId") workspaceId: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    const parsedLimit = limit ? Number(limit) : undefined;
    return {
      items: await this.billingService.listWalletTransactions(
        workspaceId,
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : 50,
      ),
    };
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Post("workspaces/:workspaceId/sync")
  async syncWorkspaceUsage(
    @Param("workspaceId") workspaceId: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserHasWorkspaceAccessAsync(currentUser.id, workspaceId);
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.billingService.syncWorkspaceUsage({
      workspaceId,
      limit:
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
      : 100,
    });
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Post("workspaces/:workspaceId/topups")
  async createWalletTopup(
    @Param("workspaceId") workspaceId: string,
    @Body() body: CreateWalletTopupDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, workspaceId);
    return this.billingService.createWalletTopup({
      workspaceId,
      amountCny: body.amountCny,
      title: body.title,
    });
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Post("workspaces/:workspaceId/adjustments")
  async createWalletAdjustment(
    @Param("workspaceId") workspaceId: string,
    @Body() body: CreateWalletAdjustmentDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, workspaceId);
    return this.billingService.createWalletAdjustment({
      workspaceId,
      amountCny: body.amountCny,
      title: body.title,
    });
  }

  @Header("Deprecation", "true")
  @Header("X-Xiaolanbu-Legacy-Route", "true")
  @Post("workspaces/:workspaceId/reconcile")
  async reconcileWorkspaceGatewayBudgets(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    await this.storeService.assertUserCanManageWorkspaceAsync(currentUser.id, workspaceId);
    return this.billingService.reconcileWorkspaceGatewayBudgets(workspaceId);
  }
}
