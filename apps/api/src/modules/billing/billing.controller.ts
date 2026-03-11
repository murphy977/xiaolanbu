import { Body, Controller, Get, Headers, Param, Post, Query, UnauthorizedException } from "@nestjs/common";

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

  private requireUser(sessionToken?: string) {
    const user = this.storeService.getUserBySessionToken(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  @Get("workspaces/:workspaceId/wallet")
  getWallet(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    return {
      wallet: this.storeService.getWallet(workspaceId),
    };
  }

  @Get("workspaces/:workspaceId/usage")
  getUsageSummary(
    @Param("workspaceId") workspaceId: string,
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    return {
      summary: this.storeService.getUsageSummary(workspaceId, period ?? "today"),
    };
  }

  @Get("workspaces/:workspaceId/deployments/summary")
  listDeploymentUsageSummaries(
    @Param("workspaceId") workspaceId: string,
    @Query("period") period?: "today" | "7d" | "30d",
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    return {
      items: this.billingService.listDeploymentUsageSummaries(workspaceId, period ?? "today"),
    };
  }

  @Get("workspaces/:workspaceId/feed")
  listBillingFeed(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    return {
      items: this.storeService.listBillingFeed(workspaceId),
    };
  }

  @Get("workspaces/:workspaceId/ledger")
  listUsageLedger(
    @Param("workspaceId") workspaceId: string,
    @Query("deploymentId") deploymentId?: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    const parsedLimit = limit ? Number(limit) : undefined;
    return {
      items: this.billingService.listUsageLedger(workspaceId, {
        deploymentId,
        limit:
          typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? parsedLimit
            : 50,
      }),
    };
  }

  @Get("workspaces/:workspaceId/transactions")
  listWalletTransactions(
    @Param("workspaceId") workspaceId: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    const parsedLimit = limit ? Number(limit) : undefined;
    return {
      items: this.billingService.listWalletTransactions(
        workspaceId,
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : 50,
      ),
    };
  }

  @Post("workspaces/:workspaceId/sync")
  async syncWorkspaceUsage(
    @Param("workspaceId") workspaceId: string,
    @Query("limit") limit?: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserHasWorkspaceAccess(currentUser.id, workspaceId);
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.billingService.syncWorkspaceUsage({
      workspaceId,
      limit:
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
      : 100,
    });
  }

  @Post("workspaces/:workspaceId/topups")
  async createWalletTopup(
    @Param("workspaceId") workspaceId: string,
    @Body() body: CreateWalletTopupDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, workspaceId);
    return this.billingService.createWalletTopup({
      workspaceId,
      amountCny: body.amountCny,
      title: body.title,
    });
  }

  @Post("workspaces/:workspaceId/adjustments")
  async createWalletAdjustment(
    @Param("workspaceId") workspaceId: string,
    @Body() body: CreateWalletAdjustmentDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, workspaceId);
    return this.billingService.createWalletAdjustment({
      workspaceId,
      amountCny: body.amountCny,
      title: body.title,
    });
  }

  @Post("workspaces/:workspaceId/reconcile")
  async reconcileWorkspaceGatewayBudgets(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = this.requireUser(sessionToken);
    this.storeService.assertUserCanManageWorkspace(currentUser.id, workspaceId);
    return this.billingService.reconcileWorkspaceGatewayBudgets(workspaceId);
  }
}
