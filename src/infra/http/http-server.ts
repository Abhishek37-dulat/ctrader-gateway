import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AppEnv } from "../../config/env.js";
import type { Logger } from "../logger.js";
import { HttpError } from "./errors.js";
import type { RequestCtx, CTraderEnv } from "./http-types.js";

export class HttpServer {
  public readonly app: FastifyInstance;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
  ) {
    // ✅ Give Fastify a CONFIG OBJECT (no wrapper, no pino instance)
    this.app = fastify({
      logger: {
        level: env.logLevel,
        base: null,
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
      },
    });

    this.app.setErrorHandler(
      (err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
        if (err instanceof HttpError) {
          return reply
            .status(err.status)
            .send({ error: err.message, details: err.details ?? null });
        }

        // Use your app logger (clean + consistent)
        this.logger.error({ err }, "Unhandled error");
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      },
    );

    // Internal auth (optional)
    this.app.addHook("preHandler", async (req, reply) => {
      if (!this.env.internalApiKey) return;

      const key = String(req.headers["x-internal-key"] ?? "");
      if (key !== this.env.internalApiKey) {
        return reply.status(401).send({ error: "UNAUTHORIZED" });
      }
    });

    // Attach ctx for routes
    this.app.decorateRequest("ctx", null);

    this.app.addHook("preHandler", async (req) => {
      const userId = String(req.headers["x-user-id"] ?? "").trim();

      const envHeaderRaw = String(req.headers["x-ctrader-env"] ?? "")
        .trim()
        .toLowerCase();

      const tokenOverrideRaw = String(
        req.headers["x-ctrader-access-token"] ?? "",
      ).trim();

      const envOverride: CTraderEnv | undefined =
        envHeaderRaw === "demo" || envHeaderRaw === "live"
          ? (envHeaderRaw as CTraderEnv)
          : undefined;

      // ✅ exactOptionalPropertyTypes safe: don't assign undefined fields
      const ctx: RequestCtx = Object.freeze({
        userId,
        ...(envOverride ? { env: envOverride } : {}),
        ...(tokenOverrideRaw ? { tokenOverride: tokenOverrideRaw } : {}),
      });

      (req as any).ctx = ctx;
    });
  }

  async listen(): Promise<void> {
    await this.app.listen({ host: "127.0.0.1", port: this.env.port });
    this.logger.info(
      { port: this.env.port },
      `✅ ctrader-gateway listening on http://127.0.0.1:${this.env.port}`,
    );
  }
}
