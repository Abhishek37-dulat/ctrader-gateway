// src/infra/http/http-server.ts
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AppEnv } from "../../config/env.js";
import type { Logger } from "../logger.js";
import { HttpError, toHttpError } from "./errors.js";
import type { RequestCtx, CTraderEnv } from "./http-types.js";

function safeUserId(v: unknown): string {
  const s = String(v ?? "").trim();
  return s.length ? s : "";
}

function safeEnv(v: unknown): CTraderEnv | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "demo" || s === "live" ? (s as CTraderEnv) : undefined;
}

function safeToken(v: unknown): string | undefined {
  const s = String(v ?? "").trim();
  return s.length ? s : undefined;
}

export class HttpServer {
  public readonly app: FastifyInstance;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
  ) {
    this.app = fastify({
      logger: {
        level: env.logLevel,
        base: null,
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
      },
      // trustProxy: true,
    });

    // Always return request id for easier debugging
    this.app.addHook("onRequest", async (req, reply) => {
      try {
        reply.header("x-request-id", req.id);
      } catch (err) {
        // Never crash on headers; let Fastify handle request
        this.logger.warn({ err }, "Failed to set x-request-id header");
      }
    });

    this.app.setErrorHandler(
      (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
        const httpErr = toHttpError(err);

        // Log carefully: never include oauth code or access token
        const logBase = {
          reqId: req.id,
          method: req.method,
          url: req.url,
          userId: (req as any)?.ctx?.userId || undefined,
          status: httpErr.status,
        };

        // 4xx are expected; 5xx are unexpected
        if (httpErr.status >= 500) {
          this.logger.error({ ...logBase, err }, "Unhandled server error");
        } else {
          this.logger.warn({ ...logBase, err }, "Request error");
        }

        // Consistent response shape
        const payload = {
          error: httpErr.message,
          details: httpErr.details ?? null,
          requestId: req.id,
        };

        // If reply already sent, do nothing (avoid throwing again)
        if ((reply as any).sent) return;

        return reply.status(httpErr.status).send(payload);
      },
    );

    // Internal auth (optional)
    this.app.addHook("preHandler", async (req, reply) => {
      try {
        if (!this.env.internalApiKey) return;

        const key = String(req.headers["x-internal-key"] ?? "");
        if (key !== this.env.internalApiKey) {
          // Do not throw here; directly respond
          reply.status(401).send({
            error: "UNAUTHORIZED",
            details: null,
            requestId: req.id,
          });
          return;
        }
      } catch (err) {
        // Convert to HttpError so our errorHandler formats consistently
        throw new HttpError(500, "INTERNAL_ERROR", undefined, err);
      }
    });

    // Attach ctx for routes
    this.app.decorateRequest("ctx", null);

    this.app.addHook("preHandler", async (req) => {
      try {
        const userId = safeUserId(req.headers["x-user-id"]);

        const envOverride = safeEnv(req.headers["x-ctrader-env"]);
        const tokenOverride = safeToken(req.headers["x-ctrader-access-token"]);

        const ctx: RequestCtx = Object.freeze({
          userId,
          ...(envOverride ? { env: envOverride } : {}),
          ...(tokenOverride ? { tokenOverride } : {}),
        });

        (req as any).ctx = ctx;
      } catch (err) {
        // If ctx creation fails, make it a 500 (should never happen)
        throw new HttpError(500, "INTERNAL_ERROR", undefined, err);
      }
    });
  }

  async listen(): Promise<void> {
    const host = "0.0.0.0";
    const port = this.env.port;

    try {
      await this.app.listen({ host, port });

      this.logger.info(
        { host, port },
        `✅ ctrader-gateway listening on http://${host}:${port}`,
      );
    } catch (err) {
      // Important: log bind errors clearly (EADDRINUSE, EACCES, etc.)
      this.logger.error({ err, host, port }, "❌ Failed to start HTTP server");
      throw err;
    }
  }
}
