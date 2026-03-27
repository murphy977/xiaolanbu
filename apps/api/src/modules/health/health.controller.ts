import { Controller, Get } from "@nestjs/common";

import { QueueService } from "../queue/queue.service";
import { PostgresStateService } from "../store/postgres-state.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly postgresStateService: PostgresStateService,
    private readonly queueService: QueueService,
  ) {}

  @Get()
  getHealth() {
    return {
      ok: true,
      service: "xiaolanbu-api",
      now: new Date().toISOString(),
      database: this.postgresStateService.getHealthSnapshot(),
    };
  }

  @Get("ready")
  async getReadiness() {
    const [readiness, redis] = await Promise.all([
      this.postgresStateService.checkReadiness(),
      this.queueService.ping().catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      })),
    ]);
    return {
      ...readiness,
      service: "xiaolanbu-api",
      now: new Date().toISOString(),
      redis,
      session: {
        ttlMs: Number(process.env.XLB_SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
        touchIntervalMs: Number(process.env.XLB_SESSION_TOUCH_INTERVAL_MS ?? 60 * 60 * 1000),
        cleanupIntervalMs: Number(process.env.XLB_SESSION_CLEANUP_INTERVAL_MS ?? 15 * 60 * 1000),
      },
      billingSync: {
        leaderLockId: Number(process.env.XLB_BILLING_SYNC_LOCK_ID ?? 18032026),
      },
      queues: this.queueService.getRedisHealthSnapshot(),
    };
  }
}
