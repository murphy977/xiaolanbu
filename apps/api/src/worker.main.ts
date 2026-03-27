import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { WorkerModule } from "./worker.module";

async function bootstrap() {
  process.env.XLB_JOB_WORKER_MODE = "true";
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "warn", "error", "debug"],
  });
  const logger = new Logger("XiaolanbuWorker");
  logger.log("worker process started");

  const shutdown = async () => {
    logger.log("worker process shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start Xiaolanbu worker", error);
  process.exit(1);
});
