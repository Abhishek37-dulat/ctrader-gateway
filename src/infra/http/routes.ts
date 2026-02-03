// src/infra/http/routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError, badRequest, toHttpError } from "./errors.js";
import type { RequestCtx } from "./http-types.js";

import type { OAuthService } from "../oauth/oauth.service.js";
import type {
  CTraderGateway,
  TradeSide,
  OrderType,
} from "../ctrader/ctrader-gateway.js";
import type { Logger } from "../logger.js";

type Deps = {
  oauth: OAuthService;
  gateway: CTraderGateway;
  logger: Logger;
};

const ORDER_TYPES: readonly OrderType[] = [
  "MARKET",
  "LIMIT",
  "STOP",
  "STOP_LIMIT",
  "MARKET_RANGE",
] as const;

function getCtx(req: FastifyRequest): RequestCtx {
  return (req as any).ctx as RequestCtx;
}

function mustUserId(ctx: RequestCtx, body: any): string {
  const userId = ctx.userId || String(body?.userId ?? "").trim();
  if (!userId) throw new HttpError(400, "x-user-id header (or body.userId) required");
  return userId;
}

function parseSide(v: unknown): TradeSide {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "BUY" || s === "SELL") return s;
  throw badRequest("side must be BUY or SELL", { received: v });
}

function parseOrderType(v: unknown): OrderType {
  const s = String(v ?? "").trim().toUpperCase();
  if ((ORDER_TYPES as readonly string[]).includes(s)) return s as OrderType;
  throw badRequest("orderType invalid", { allowed: ORDER_TYPES, received: v });
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function optNum(v: any, fieldName = "number"): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Invalid number field: ${fieldName}`, { received: v });
  return n;
}

function optStr(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

/**
 * Wraps handlers with try/catch:
 * - normalizes unknown errors to HttpError
 * - logs with reqId + route (no secrets)
 * - rethrows for global errorHandler to respond consistently
 */
function wrap(
  deps: Deps,
  routeName: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<any>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(req, reply);
    } catch (err) {
      const httpErr = toHttpError(err);

      const ctx = (req as any)?.ctx as RequestCtx | undefined;

      // Avoid logging sensitive body content (oauth code, tokens, etc.)
      const logBase = {
        route: routeName,
        reqId: req.id,
        method: req.method,
        url: req.url,
        status: httpErr.status,
        userId: ctx?.userId || undefined,
        env: ctx?.env || undefined,
      };

      if (httpErr.status >= 500) {
        deps.logger.error({ ...logBase, err }, "Route failed (server)");
      } else {
        deps.logger.warn({ ...logBase, err }, "Route failed (client)");
      }

      throw httpErr;
    }
  };
}

export function registerRoutes(app: FastifyInstance, deps: Deps) {
  app.get(
    "/health",
    wrap(deps, "health", async () => ({ ok: true })),
  );

  app.post(
    "/oauth/exchange",
    wrap(deps, "oauth.exchange", async (req) => {
      console.log("OAuth exchange endpoint called", req.body);
      const ctx = getCtx(req);
      const body = (req.body ?? {}) as any;

      const userId = mustUserId(ctx, body);
      const code = String(body?.code ?? "").trim();
      if (!code) throw badRequest("code required");

      // DO NOT log code anywhere (wrapper already avoids body logs)
      return deps.oauth.exchangeCodeAndStore(userId, code);
    }),
  );

  app.post(
    "/oauth/refresh",
    wrap(deps, "oauth.refresh", async (req) => {
      const ctx = getCtx(req);
      const body = (req.body ?? {}) as any;

      const userId = mustUserId(ctx, body);
      return deps.oauth.refreshAndStore(userId);
    }),
  );

  app.get(
    "/accounts",
    wrap(deps, "accounts.list", async (req) => {
      const ctx = getCtx(req);
      if (!ctx.userId) throw badRequest("x-user-id required");
      return deps.gateway.listAccounts(ctx.userId, ctx.env);
    }),
  );

  app.post(
    "/auth/account",
    wrap(deps, "auth.account", async (req) => {
      const ctx = getCtx(req);
      const body = (req.body ?? {}) as any;

      const userId = mustUserId(ctx, body);
      const accountId = Number(body?.accountId);

      if (!Number.isFinite(accountId) || accountId <= 0) {
        throw badRequest("accountId must be a positive number", { received: body?.accountId });
      }

      return deps.gateway.authorizeAccount(userId, accountId, ctx.env);
    }),
  );

  app.get(
    "/symbols",
    wrap(deps, "symbols.list", async (req) => {
      const ctx = getCtx(req);
      const q = String((req.query as any)?.q ?? "");
      const limitRaw = Number((req.query as any)?.limit ?? 200);

      if (!ctx.userId) throw badRequest("x-user-id required");

      const limit = Number.isFinite(limitRaw) ? clampInt(limitRaw, 1, 2000) : 200;

      return deps.gateway.listSymbols(ctx.userId, q, limit, ctx.env);
    }),
  );

  app.get(
    "/quote",
    wrap(deps, "quote.get", async (req) => {
      const ctx = getCtx(req);
      const symbol = String((req.query as any)?.symbol ?? "").trim();
      const waitRaw = Number((req.query as any)?.wait ?? 0);

      if (!ctx.userId) throw badRequest("x-user-id required");
      if (!symbol) throw badRequest("symbol is required");

      const wait = Number.isFinite(waitRaw) ? Math.max(waitRaw, 0) : 0;

      return deps.gateway.getQuote(ctx.userId, symbol, wait, ctx.env);
    }),
  );

  app.get(
    "/account",
    wrap(deps, "account.get", async (req) => {
      const ctx = getCtx(req);
      if (!ctx.userId) throw badRequest("x-user-id required");
      return deps.gateway.getAccountInfo(ctx.userId, ctx.env);
    }),
  );

  app.post(
    "/trade",
    wrap(deps, "trade.place", async (req) => {
      const ctx = getCtx(req);
      const body = (req.body ?? {}) as any;

      const userId = mustUserId(ctx, body);

      const symbol = String(body?.symbol ?? "").trim();
      if (!symbol) throw badRequest("symbol is required");

      const side = parseSide(body?.side);
      const orderType = parseOrderType(body?.orderType);

      const volumeUnits = Number(body?.volumeUnits);
      if (!Number.isFinite(volumeUnits) || volumeUnits <= 0) {
        throw badRequest("volumeUnits must be > 0", { received: body?.volumeUnits });
      }

      const accountId = optNum(body?.accountId, "accountId");
      optNum(body?.accountId, "accountId");
      if (accountId !== undefined && accountId <= 0) {
        throw badRequest("accountId must be a positive number", { received: body?.accountId });
      }

      const limitPrice = optNum(body?.limitPrice, "limitPrice");
      const stopPrice = optNum(body?.stopPrice, "stopPrice");
      const stopLoss = optNum(body?.stopLoss, "stopLoss");
      const takeProfit = optNum(body?.takeProfit, "takeProfit");
      const stopLossDistance = optNum(body?.stopLossDistance, "stopLossDistance");
      const takeProfitDistance = optNum(body?.takeProfitDistance, "takeProfitDistance");

      const comment = optStr(body?.comment);
      const label = optStr(body?.label);

      // Optional: basic consistency checks (safe + helpful)
      if (orderType === "LIMIT" && limitPrice === undefined) {
        throw badRequest("limitPrice is required for LIMIT orders");
      }
      if (orderType === "STOP" && stopPrice === undefined) {
        throw badRequest("stopPrice is required for STOP orders");
      }
      if (orderType === "STOP_LIMIT" && (stopPrice === undefined || limitPrice === undefined)) {
        throw badRequest("stopPrice and limitPrice are required for STOP_LIMIT orders");
      }

      return deps.gateway.placeTrade({
        userId,
        symbol,
        side,
        orderType,
        volumeUnits,

        ...(ctx.env ? { env: ctx.env } : {}),
        ...(accountId !== undefined ? { accountId } : {}),

        ...(limitPrice !== undefined ? { limitPrice } : {}),
        ...(stopPrice !== undefined ? { stopPrice } : {}),
        ...(stopLoss !== undefined ? { stopLoss } : {}),
        ...(takeProfit !== undefined ? { takeProfit } : {}),
        ...(stopLossDistance !== undefined ? { stopLossDistance } : {}),
        ...(takeProfitDistance !== undefined ? { takeProfitDistance } : {}),

        ...(comment ? { comment } : {}),
        ...(label ? { label } : {}),
      });
    }),
  );
}
