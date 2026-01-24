// src/infra/ctrader/ctrader-gateway.ts
import type { Logger } from "../logger.js";
import type { TokenStore } from "../redis/token-store.js";
import type { QuoteBus, Quote } from "./quote-bus.js";
import { SymbolCache } from "./symbol-cache.js";
import type { CTraderConnection } from "./ctrader-connection.js";
import type { CTraderEnv } from "../../config/env.js";

export type ListAccountsResult = Readonly<{
  count: number;
  items: Array<{
    ctidTraderAccountId: string;
    isLive?: boolean;
    traderLogin?: string;
    lastClosingDealTimestamp?: string;
    lastBalanceUpdateTimestamp?: string;
  }>;
}>;

export type TradeSide = "BUY" | "SELL";
export type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "MARKET_RANGE";

export type TradeRequest = Readonly<{
  userId: string;
  env?: CTraderEnv;
  accountId?: number;

  symbol: string;
  side: TradeSide;
  orderType: OrderType;

  volumeUnits: number;

  limitPrice?: number;
  stopPrice?: number;

  stopLoss?: number;
  takeProfit?: number;

  stopLossDistance?: number;
  takeProfitDistance?: number;

  comment?: string;
  label?: string;
}>;

export class CTraderGateway {
  private readonly symbols = new SymbolCache();

  constructor(
    private readonly store: TokenStore,
    private readonly ctrader: CTraderConnection,
    private readonly quotes: QuoteBus,
    private readonly logger: Logger,
  ) {}

  // ---------- resolution helpers ----------

  private async resolveEnv(userId: string, envOverride?: CTraderEnv): Promise<CTraderEnv> {
    if (envOverride) return envOverride;
    const s = await this.store.loadSession(userId);
    return s?.env ?? "demo";
  }

  private async resolveAccessToken(userId: string): Promise<string> {
    const t = await this.store.loadAccessToken(userId);
    if (!t) {
      throw new Error(
        "No access token available (store empty). Use /oauth/exchange first.",
      );
    }
    return t;
  }

  private async resolveAccountId(userId: string, accountOverride?: number): Promise<number> {
    if (accountOverride && accountOverride > 0) return accountOverride;

    const s = await this.store.loadSession(userId);
    const aid = s?.activeAccountId;

    if (!aid || aid <= 0) {
      throw new Error("No activeAccountId. Call POST /auth/account first.");
    }

    return aid;
  }

  // ---------- APIs ----------

  async listAccounts(userId: string, envOverride?: CTraderEnv): Promise<ListAccountsResult> {
    // env currently only stored; connection uses global env.ctrader.env
    await this.resolveEnv(userId, envOverride);

    const accessToken = await this.resolveAccessToken(userId);

    const res = await this.ctrader.send(
      "PROTO_OA_GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_REQ",
      { accessToken },
      12_000,
    );

    const decoded = (res as any)?.decoded ?? res;
    const accounts = Array.isArray(decoded?.ctidTraderAccount)
      ? decoded.ctidTraderAccount
      : [];

    return Object.freeze({ count: accounts.length, items: accounts });
  }

  async authorizeAccount(
    userId: string,
    accountId: number,
    envOverride?: CTraderEnv,
  ): Promise<any> {
    const env = await this.resolveEnv(userId, envOverride);
    const accessToken = await this.resolveAccessToken(userId);

    const res = await this.ctrader.send(
      "PROTO_OA_ACCOUNT_AUTH_REQ",
      { ctidTraderAccountId: accountId, accessToken },
      12_000,
    );

    await this.store.setActiveAccountId(userId, accountId);
    await this.store.setEnv(userId, env);

    return Object.freeze({
      authorized: true,
      activeAccountId: accountId,
      response: (res as any)?.decoded ?? res,
    });
  }

  async listSymbols(
    userId: string,
    q: string,
    limit: number,
    envOverride?: CTraderEnv,
  ): Promise<any> {
    const env = await this.resolveEnv(userId, envOverride);
    const accountId = await this.resolveAccountId(userId);

    let cache = this.symbols.get(userId, env, accountId);
    if (!cache) cache = await this.refreshSymbols(userId, env, accountId);

    const needle = q.trim().toUpperCase();
    const out: Array<{ symbol: string; symbolId: number }> = [];

    for (const [name, id] of cache.entries()) {
      if (needle && !name.includes(needle)) continue;
      out.push({ symbol: name, symbolId: id });
      if (out.length >= limit) break;
    }

    return { activeAccountId: accountId, count: out.length, items: out };
  }

  async getQuote(
    userId: string,
    symbol: string,
    waitSeconds: number,
    envOverride?: CTraderEnv,
  ): Promise<Quote> {
    const env = await this.resolveEnv(userId, envOverride);
    const accountId = await this.resolveAccountId(userId);

    const symbolId = await this.ensureSymbolId(userId, env, accountId, symbol);

    await this.ctrader.send(
      "PROTO_OA_SUBSCRIBE_SPOTS_REQ",
      {
        ctidTraderAccountId: accountId,
        symbolId: [symbolId],
        subscribeToSpotTimestamp: true,
      },
      12_000,
    );

    if (!waitSeconds || waitSeconds <= 0) {
      const last = this.quotes.getLast(userId, env, accountId, symbolId);
      if (!last) throw new Error("No quote received yet. Try again with ?wait=5");
      return last;
    }

    return await this.quotes.waitForNext(
      userId,
      env,
      accountId,
      symbolId,
      Math.floor(waitSeconds * 1000),
    );
  }

  async getAccountInfo(userId: string, envOverride?: CTraderEnv): Promise<any> {
    const env = await this.resolveEnv(userId, envOverride);
    const accountId = await this.resolveAccountId(userId);

    const res = await this.ctrader.send(
      "PROTO_OA_TRADER_REQ",
      { ctidTraderAccountId: accountId },
      12_000,
    );

    return (res as any)?.decoded ?? res;
  }

  async placeTrade(req: TradeRequest): Promise<any> {
    const env = await this.resolveEnv(req.userId, req.env);
    const accountId = await this.resolveAccountId(req.userId, req.accountId);
    const symbolId = await this.ensureSymbolId(req.userId, env, accountId, req.symbol);

    const orderType = req.orderType.toUpperCase() as OrderType;
    const side = req.side.toUpperCase() as TradeSide;

    if (side !== "BUY" && side !== "SELL") throw new Error("side must be BUY or SELL");

    const volume = Math.round(req.volumeUnits * 100);
    if (!Number.isFinite(volume) || volume <= 0) throw new Error("volumeUnits must be > 0");

    const base: Record<string, unknown> = {
      ctidTraderAccountId: accountId,
      symbolId,
      tradeSide: side,
      orderType,
      volume,
    };

    if (req.comment) base.comment = req.comment;
    if (req.label) base.label = req.label;

    if (orderType === "LIMIT") {
      if (req.limitPrice == null) throw new Error("limitPrice is required for LIMIT");
      base.limitPrice = req.limitPrice;
    }

    if (orderType === "STOP" || orderType === "STOP_LIMIT") {
      if (req.stopPrice == null) throw new Error("stopPrice is required for STOP/STOP_LIMIT");
      base.stopPrice = req.stopPrice;
    }

    if (orderType === "MARKET") {
      if (req.stopLoss != null || req.takeProfit != null) {
        throw new Error(
          "For MARKET orders, stopLoss/takeProfit absolute prices are not allowed. Use stopLossDistance/takeProfitDistance.",
        );
      }
      if (req.stopLossDistance != null) base.stopLossDistance = req.stopLossDistance;
      if (req.takeProfitDistance != null) base.takeProfitDistance = req.takeProfitDistance;
    } else {
      if (req.stopLoss != null) base.stopLoss = req.stopLoss;
      if (req.takeProfit != null) base.takeProfit = req.takeProfit;
    }

    const res = await this.ctrader.send(
      "PROTO_OA_NEW_ORDER_REQ",
      base,
      15_000,
    );

    this.logger.info(
      { userId: req.userId, env, accountId, symbol: req.symbol, orderType, side },
      "✅ Trade request sent",
    );

    return {
      request: { ...req, accountId, env, symbolId },
      response: (res as any)?.decoded ?? res,
    };
  }

  // ---------- helpers ----------

  private async refreshSymbols(
    userId: string,
    env: CTraderEnv,
    accountId: number,
  ): Promise<Map<string, number>> {
    const res = await this.ctrader.send(
      "PROTO_OA_SYMBOLS_LIST_REQ",
      { ctidTraderAccountId: accountId, includeArchivedSymbols: false },
      15_000,
    );

    const decoded = (res as any)?.decoded ?? res;
    const symbolsArr = Array.isArray(decoded?.symbol) ? decoded.symbol : [];

    const map = new Map<string, number>();
    for (const s of symbolsArr) {
      const name = String(s.symbolName ?? s.name ?? "").toUpperCase().trim();
      const id = Number(s.symbolId);
      if (name && Number.isFinite(id)) map.set(name, id);
    }

    this.symbols.set(userId, env, accountId, map);
    return map;
  }

  private async ensureSymbolId(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    symbol: string,
  ): Promise<number> {
    const sym = symbol.trim().toUpperCase();

    let cache = this.symbols.get(userId, env, accountId);
    if (!cache) cache = await this.refreshSymbols(userId, env, accountId);

    const id = cache.get(sym);
    if (id == null) throw new Error(`Symbol not found: ${symbol}`);
    return id;
  }
}
