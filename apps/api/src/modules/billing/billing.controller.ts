import { Controller, Get, Param, Post, Query } from "@nestjs/common";

import { BillingService } from "./billing.service";
import { StoreService } from "../store/store.service";

@Controller("billing")
export class BillingController {
  constructor(
    private readonly storeService: StoreService,
    private readonly billingService: BillingService,
  ) {}

  @Get("workspaces/:workspaceId/wallet")
  getWallet(@Param("workspaceId") workspaceId: string) {
    return {
      wallet: this.storeService.getWallet(workspaceId),
    };
  }

  @Get("workspaces/:workspaceId/usage")
  getUsageSummary(
    @Param("workspaceId") workspaceId: string,
    @Query("period") period?: "today" | "7d" | "30d",
  ) {
    return {
      summary: this.storeService.getUsageSummary(workspaceId, period ?? "today"),
    };
  }

  @Get("workspaces/:workspaceId/deployments/summary")
  listDeploymentUsageSummaries(
    @Param("workspaceId") workspaceId: string,
    @Query("period") period?: "today" | "7d" | "30d",
  ) {
    return {
      items: this.billingService.listDeploymentUsageSummaries(workspaceId, period ?? "today"),
    };
  }

  @Get("workspaces/:workspaceId/feed")
  listBillingFeed(@Param("workspaceId") workspaceId: string) {
    return {
      items: this.storeService.listBillingFeed(workspaceId),
    };
  }

  @Get("workspaces/:workspaceId/ledger")
  listUsageLedger(
    @Param("workspaceId") workspaceId: string,
    @Query("deploymentId") deploymentId?: string,
    @Query("limit") limit?: string,
  ) {
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
  ) {
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
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.billingService.syncWorkspaceUsage({
      workspaceId,
      limit:
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : 100,
    });
  }
}
