import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { BILLING_SYNC_USER_JOB } from "../queue/queue.constants";
import { QueueService } from "../queue/queue.service";
import { PostgresStateService } from "../store/postgres-state.service";
import { StoreService } from "../store/store.service";
import { BillingService } from "./billing.service";

@Injectable()
export class BillingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingSyncService.name);
  private readonly leaderLockId = this.readLeaderLockId();
  private timer: NodeJS.Timeout | null = null;
  private syncInFlight = false;

  constructor(
    private readonly storeService: StoreService,
    private readonly billingService: BillingService,
    private readonly postgresStateService: PostgresStateService,
    private readonly queueService: QueueService,
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

    this.logger.log(
      `Automatic billing sync enabled. intervalMs=${intervalMs} leaderLockId=${this.leaderLockId}`,
    );
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
      const run = async () => {
        const userIds = (await this.storeService.listUsersAsync()).map((user) => user.id);

        if (this.queueService.isEnabled() && !this.queueService.isWorkerMode()) {
          for (const userId of userIds) {
            await this.queueService.enqueueBillingJobIfIdle(
              BILLING_SYNC_USER_JOB,
              {
                userId,
                limit,
                reason,
              },
              `billing-sync-${userId}`,
            );
          }
          this.logger.log(`Billing sync (${reason}) enqueued users=${userIds.length}`);
          return;
        }

        for (const userId of userIds) {
          const result = await this.billingService.syncUserUsage({
            userId,
            limit,
          });

          if (result.synced > 0 || result.scanned > 0) {
            this.logger.log(
              `Billing sync (${reason}) user=${userId} scope=${result.accountScopeId} scanned=${result.scanned} synced=${result.synced} skipped=${result.skipped}`,
            );
          }
        }
      };

      if (!this.postgresStateService.isEnabled()) {
        await run();
        return;
      }

      const locked = await this.postgresStateService.withAdvisoryLock(
        this.leaderLockId,
        0,
        async () => {
          await run();
          return true;
        },
      );
      if (!locked.acquired) {
        this.logger.debug(`Skipped ${reason} billing sync cycle because another replica holds the leader lock.`);
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

  private readLeaderLockId() {
    const value = Number(process.env.XLB_BILLING_SYNC_LOCK_ID ?? "18032026");
    return Number.isFinite(value) ? Math.trunc(value) : 18032026;
  }
}
