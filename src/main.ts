// src/main.ts
import "dotenv/config"; // MUST be first

import { Env } from "./config/env.js";
import { Logger } from "./infra/logger.js";
import { App } from "./app.js";

async function bootstrap() {
  const env = Env.load(); // reads process.env (now dotenv already loaded)
  const logger = Logger.create(env);

  logger.info({ env: env.nodeEnv, port: env.port }, "✅ Booting");

  const app = new App(env, logger);
  await app.start();
}

bootstrap().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
