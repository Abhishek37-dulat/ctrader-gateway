// src/infra/http/http-server.ts
import fastify from "fastify";
import { HttpError, toHttpError } from "./errors.js";
function safeUserId(v) {
    const s = String(v ?? "").trim();
    return s.length ? s : "";
}
function safeEnv(v) {
    const s = String(v ?? "").trim().toLowerCase();
    return s === "demo" || s === "live" ? s : undefined;
}
function safeToken(v) {
    const s = String(v ?? "").trim();
    return s.length ? s : undefined;
}
export class HttpServer {
    constructor(env, logger) {
        this.env = env;
        this.logger = logger;
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
            }
            catch (err) {
                // Never crash on headers; let Fastify handle request
                this.logger.warn({ err }, "Failed to set x-request-id header");
            }
        });
        this.app.setErrorHandler((err, req, reply) => {
            const httpErr = toHttpError(err);
            // Log carefully: never include oauth code or access token
            const logBase = {
                reqId: req.id,
                method: req.method,
                url: req.url,
                userId: req?.ctx?.userId || undefined,
                status: httpErr.status,
            };
            // 4xx are expected; 5xx are unexpected
            if (httpErr.status >= 500) {
                this.logger.error({ ...logBase, err }, "Unhandled server error");
            }
            else {
                this.logger.warn({ ...logBase, err }, "Request error");
            }
            // Consistent response shape
            const payload = {
                error: httpErr.message,
                details: httpErr.details ?? null,
                requestId: req.id,
            };
            // If reply already sent, do nothing (avoid throwing again)
            if (reply.sent)
                return;
            return reply.status(httpErr.status).send(payload);
        });
        // Internal auth (optional)
        this.app.addHook("preHandler", async (req, reply) => {
            try {
                if (!this.env.internalApiKey)
                    return;
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
            }
            catch (err) {
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
                const ctx = Object.freeze({
                    userId,
                    ...(envOverride ? { env: envOverride } : {}),
                    ...(tokenOverride ? { tokenOverride } : {}),
                });
                req.ctx = ctx;
            }
            catch (err) {
                // If ctx creation fails, make it a 500 (should never happen)
                throw new HttpError(500, "INTERNAL_ERROR", undefined, err);
            }
        });
    }
    async listen() {
        const host = "0.0.0.0";
        const port = this.env.port;
        try {
            await this.app.listen({ host, port });
            this.logger.info({ host, port }, `✅ ctrader-gateway listening on http://${host}:${port}`);
        }
        catch (err) {
            // Important: log bind errors clearly (EADDRINUSE, EACCES, etc.)
            this.logger.error({ err, host, port }, "❌ Failed to start HTTP server");
            throw err;
        }
    }
}
