import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";
import { MetricsService } from "./modules/metrics/metrics.service";
import { PostgresStateService } from "./modules/store/postgres-state.service";

// Avoid adding a new type package just to raise the request body limit.
const { json, urlencoded } = require("express");

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
    bodyParser: false,
  });

  const bodyLimit = process.env.XLB_API_BODY_LIMIT?.trim() || "8mb";
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  const metricsService = app.get(MetricsService);
  app.use((req: any, res: any, next: () => void) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      metricsService.observeHttpRequest({
        method: String(req.method ?? "GET"),
        route: metricsService.resolveRouteLabel(req),
        statusCode: Number(res.statusCode ?? 500),
        durationSeconds,
      });
    });
    next();
  });

  app.setGlobalPrefix("v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.PORT ?? 3030);
  const postgresStateService = app.get(PostgresStateService);
  console.log(
    `[xiaolanbu-api] starting dbEnabled=${postgresStateService.isEnabled()} sessionTtlMs=${
      process.env.XLB_SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000
    } sessionTouchIntervalMs=${
      process.env.XLB_SESSION_TOUCH_INTERVAL_MS ?? 60 * 60 * 1000
    } sessionCleanupIntervalMs=${
      process.env.XLB_SESSION_CLEANUP_INTERVAL_MS ?? 15 * 60 * 1000
    } billingSyncLockId=${process.env.XLB_BILLING_SYNC_LOCK_ID ?? 18032026} requestTimeoutMs=${
      process.env.XLB_API_REQUEST_TIMEOUT_MS ?? 960000
    } keepAliveTimeoutMs=${process.env.XLB_API_KEEP_ALIVE_TIMEOUT_MS ?? 75000}`,
  );
  const server = await app.listen(port, "0.0.0.0");
  const requestTimeoutMs = Number(process.env.XLB_API_REQUEST_TIMEOUT_MS ?? "960000");
  const keepAliveTimeoutMs = Number(process.env.XLB_API_KEEP_ALIVE_TIMEOUT_MS ?? "75000");
  const headersTimeoutMs = Number(process.env.XLB_API_HEADERS_TIMEOUT_MS ?? String(keepAliveTimeoutMs + 5000));
  server.requestTimeout =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs >= 0 ? Math.floor(requestTimeoutMs) : 960000;
  server.keepAliveTimeout =
    Number.isFinite(keepAliveTimeoutMs) && keepAliveTimeoutMs > 0 ? Math.floor(keepAliveTimeoutMs) : 75000;
  server.headersTimeout =
    Number.isFinite(headersTimeoutMs) && headersTimeoutMs > server.keepAliveTimeout
      ? Math.floor(headersTimeoutMs)
      : server.keepAliveTimeout + 5000;
}

bootstrap().catch((error) => {
  console.error("Failed to start Xiaolanbu API", error);
  process.exit(1);
});
