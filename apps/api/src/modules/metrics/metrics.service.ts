import { Injectable } from "@nestjs/common";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

import { QueueService } from "../queue/queue.service";
import { PostgresStateService } from "../store/postgres-state.service";

type ObserveHttpRequestInput = {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
};

@Injectable()
export class MetricsService {
  static readonly CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

  private readonly registry = new Registry();
  private readonly httpRequestsTotal = new Counter({
    name: "xlb_http_requests_total",
    help: "Total number of handled HTTP requests",
    labelNames: ["method", "route", "status_code", "status_class"] as const,
    registers: [this.registry],
  });
  private readonly httpRequestDurationSeconds = new Histogram({
    name: "xlb_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_class"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
    registers: [this.registry],
  });
  private readonly dbPoolTotal = new Gauge({
    name: "xlb_db_pool_total",
    help: "Current total PostgreSQL pool size",
    registers: [this.registry],
  });
  private readonly dbPoolIdle = new Gauge({
    name: "xlb_db_pool_idle",
    help: "Current idle PostgreSQL pool size",
    registers: [this.registry],
  });
  private readonly dbPoolWaiting = new Gauge({
    name: "xlb_db_pool_waiting",
    help: "Current PostgreSQL pool waiting count",
    registers: [this.registry],
  });
  private readonly dbEnabled = new Gauge({
    name: "xlb_db_enabled",
    help: "Whether PostgreSQL mode is enabled",
    registers: [this.registry],
  });
  private readonly queueEnabled = new Gauge({
    name: "xlb_queue_enabled",
    help: "Whether Redis queue mode is enabled",
    registers: [this.registry],
  });
  private readonly workerMode = new Gauge({
    name: "xlb_worker_mode",
    help: "Whether the current process is a worker process",
    registers: [this.registry],
  });

  constructor(
    private readonly postgresStateService: PostgresStateService,
    private readonly queueService: QueueService,
  ) {
    collectDefaultMetrics({
      register: this.registry,
      prefix: "xlb_process_",
    });
  }

  observeHttpRequest(input: ObserveHttpRequestInput) {
    const statusCode = Number.isFinite(input.statusCode) ? Math.floor(input.statusCode) : 500;
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const route = this.normalizeRouteLabel(input.route);
    const method = (input.method || "GET").toUpperCase();
    this.httpRequestsTotal.inc({
      method,
      route,
      status_code: String(statusCode),
      status_class: statusClass,
    });
    this.httpRequestDurationSeconds.observe(
      {
        method,
        route,
        status_class: statusClass,
      },
      Math.max(0, input.durationSeconds || 0),
    );
  }

  resolveRouteLabel(req: any) {
    const routePath =
      typeof req?.route?.path === "string"
        ? req.route.path
        : typeof req?.path === "string"
          ? req.path
          : typeof req?.originalUrl === "string"
            ? req.originalUrl
            : "unknown";
    const baseUrl = typeof req?.baseUrl === "string" ? req.baseUrl : "";
    return this.normalizeRouteLabel(`${baseUrl}${routePath}`);
  }

  async render() {
    this.refreshRuntimeGauges();
    return this.registry.metrics();
  }

  private refreshRuntimeGauges() {
    const dbSnapshot = this.postgresStateService.getHealthSnapshot();
    this.dbEnabled.set(dbSnapshot.enabled ? 1 : 0);
    this.dbPoolTotal.set(dbSnapshot.pool?.total ?? 0);
    this.dbPoolIdle.set(dbSnapshot.pool?.idle ?? 0);
    this.dbPoolWaiting.set(dbSnapshot.pool?.waiting ?? 0);

    const queueSnapshot = this.queueService.getRedisHealthSnapshot();
    this.queueEnabled.set(queueSnapshot.enabled ? 1 : 0);
    this.workerMode.set(queueSnapshot.workerMode ? 1 : 0);
  }

  private normalizeRouteLabel(value: string) {
    const normalized = (value || "unknown")
      .replace(/\?.*$/, "")
      .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/:id")
      .replace(/\/deployment_[^/]+/g, "/:deploymentId")
      .replace(/\/workspace_[^/]+/g, "/:workspaceId")
      .replace(/\/user_[^/]+/g, "/:userId");
    return normalized || "unknown";
  }
}
