import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { StoreService } from "../store/store.service";
import { BillingService } from "./billing.service";

@Injectable()
export class BillingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private syncInFlight = false;

  constructor(
    private readonly storeService: StoreService,
    private readonly billingService: BillingService,
  ) {}

  onModuleInit() {
    const intervalMs = this.readIntervalMs();
    if (intervalMs <= 0) {
      this.logger.warn("Automatic billing sync disabled because interval <= 0.");
      return;
    }

    void this.runSyncCycle("startup");
    this.timer = setInterval(() => {
      void this.runSyncCycle("interval");
    }, intervalMs);
    this.timer.unref();

    this.logger.log(`Automatic billing sync enabled. intervalMs=${intervalMs}`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runSyncCycle(reason: "startup" | "interval") {
    if (this.syncInFlight) {
      this.logger.warn(`Skipped ${reason} billing sync cycle because a previous cycle is still running.`);
      return;
    }

    this.syncInFlight = true;
    try {
      const limit = this.readSyncLimit();
      const workspaces = this.storeService.listWorkspaces();

      for (const workspace of workspaces) {
        const result = await this.billingService.syncWorkspaceUsage({
          workspaceId: workspace.id,
          limit,
        });

        if (result.synced > 0 || result.scanned > 0) {
          this.logger.log(
            `Billing sync (${reason}) workspace=${workspace.id} scanned=${result.scanned} synced=${result.synced} skipped=${result.skipped}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Automatic billing sync failed during ${reason}: ${message}`);
    } finally {
      this.syncInFlight = false;
    }
  }

  private readIntervalMs() {
    const value = Number(process.env.XLB_BILLING_SYNC_INTERVAL_MS ?? "60000");
    return Number.isFinite(value) ? Math.max(0, value) : 60000;
  }

  private readSyncLimit() {
    const value = Number(process.env.XLB_BILLING_SYNC_LIMIT ?? "200");
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 200;
  }
}
