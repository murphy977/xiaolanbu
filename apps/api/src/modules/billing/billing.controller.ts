import { Controller, Get, Param, Query } from "@nestjs/common";

import { StoreService } from "../store/store.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly storeService: StoreService) {}

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

  @Get("workspaces/:workspaceId/feed")
  listBillingFeed(@Param("workspaceId") workspaceId: string) {
    return {
      items: this.storeService.listBillingFeed(workspaceId),
    };
  }
}
