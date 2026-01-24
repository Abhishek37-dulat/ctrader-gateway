import type { FastifyInstance } from "fastify";
import { HttpError } from "./errors.js";
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

function parseSide(v: unknown): TradeSide {
  const s = String(v ?? "").toUpperCase();
  if (s === "BUY" || s === "SELL") return s;
  throw new HttpError(400, "side must be BUY or SELL");
}

function parseOrderType(v: unknown): OrderType {
  const s = String(v ?? "").toUpperCase();
  if ((ORDER_TYPES as readonly string[]).includes(s)) return s as OrderType;
  throw new HttpError(
    400,
    `orderType must be one of: ${ORDER_TYPES.join(", ")}`,
  );
}

export function registerRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/health", async () => ({ ok: true }));

  app.post("/oauth/exchange", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    const body = req.body as any;

    const userId = ctx.userId || String(body?.userId ?? "").trim();
    const code = String(body?.code ?? "").trim();
    if (!userId)
      throw new HttpError(400, "x-user-id header (or body.userId) required");
    if (!code) throw new HttpError(400, "code required");

    return deps.oauth.exchangeCodeAndStore(userId, code);
  });

  app.post("/oauth/refresh", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    const body = req.body as any;

    const userId = ctx.userId || String(body?.userId ?? "").trim();
    if (!userId)
      throw new HttpError(400, "x-user-id header (or body.userId) required");

    return deps.oauth.refreshAndStore(userId);
  });

  app.get("/accounts", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    if (!ctx.userId) throw new HttpError(400, "x-user-id required");
    return deps.gateway.listAccounts(ctx.userId, ctx.env);
  });

  app.post("/auth/account", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    const body = req.body as any;

    const userId = ctx.userId || String(body?.userId ?? "").trim();
    const accountId = Number(body?.accountId);
    if (!userId)
      throw new HttpError(400, "x-user-id header (or body.userId) required");
    if (!Number.isFinite(accountId) || accountId <= 0)
      throw new HttpError(400, "accountId must be a positive number");

    return deps.gateway.authorizeAccount(userId, accountId, ctx.env);
  });

  app.get("/symbols", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    const q = String((req.query as any)?.q ?? "");
    const limit = Number((req.query as any)?.limit ?? 200);

    if (!ctx.userId) throw new HttpError(400, "x-user-id required");

    return deps.gateway.listSymbols(
      ctx.userId,
      q,
      Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 2000) : 200,
      ctx.env,
    );
  });

  app.get("/quote", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    const symbol = String((req.query as any)?.symbol ?? "").trim();
    const wait = Number((req.query as any)?.wait ?? 0);

    if (!ctx.userId) throw new HttpError(400, "x-user-id required");
    if (!symbol) throw new HttpError(400, "symbol is required");

    return deps.gateway.getQuote(
      ctx.userId,
      symbol,
      Number.isFinite(wait) ? wait : 0,
      ctx.env,
    );
  });

  app.get("/account", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    if (!ctx.userId) throw new HttpError(400, "x-user-id required");
    return deps.gateway.getAccountInfo(ctx.userId, ctx.env);
  });

  function optNum(v: any): number | undefined {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, "Invalid number field");
    return n;
  }
  function optStr(v: any): string | undefined {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s ? s : undefined;
  }

  app.post("/trade", async (req) => {
    const ctx = (req as any).ctx as RequestCtx;
    const body = req.body as any;

    const userId = ctx.userId || String(body?.userId ?? "").trim();
    if (!userId)
      throw new HttpError(400, "x-user-id header (or body.userId) required");

    const symbol = String(body?.symbol ?? "").trim();
    if (!symbol) throw new HttpError(400, "symbol is required");

    const side = parseSide(body?.side);
    const orderType = parseOrderType(body?.orderType);

    const volumeUnits = Number(body?.volumeUnits);
    if (!Number.isFinite(volumeUnits) || volumeUnits <= 0)
      throw new HttpError(400, "volumeUnits must be > 0");

    const accountId = optNum(body?.accountId);
    if (accountId !== undefined && accountId <= 0)
      throw new HttpError(400, "accountId must be a positive number");

    const limitPrice = optNum(body?.limitPrice);
    const stopPrice = optNum(body?.stopPrice);
    const stopLoss = optNum(body?.stopLoss);
    const takeProfit = optNum(body?.takeProfit);
    const stopLossDistance = optNum(body?.stopLossDistance);
    const takeProfitDistance = optNum(body?.takeProfitDistance);

    const comment = optStr(body?.comment);
    const label = optStr(body?.label);

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
  });
}
