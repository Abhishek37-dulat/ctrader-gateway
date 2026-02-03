export class CTraderGateway {
    constructor(store, symbolStore, ctrader, quotes, logger) {
        this.store = store;
        this.symbolStore = symbolStore;
        this.ctrader = ctrader;
        this.quotes = quotes;
        this.logger = logger;
    }
    // ---------- resolution helpers ----------
    async resolveEnv(userId, envOverride) {
        if (envOverride)
            return envOverride;
        const s = await this.store.loadSession(userId);
        return s?.env ?? "demo";
    }
    async resolveAccessToken(userId) {
        const t = await this.store.loadAccessToken(userId);
        if (!t) {
            throw new Error("No access token available (store empty). Use /oauth/exchange first.");
        }
        return t;
    }
    async resolveAccountId(userId, accountOverride) {
        if (accountOverride && accountOverride > 0)
            return accountOverride;
        const s = await this.store.loadSession(userId);
        const aid = s?.activeAccountId;
        if (!aid || aid <= 0) {
            throw new Error("No activeAccountId. Call POST /auth/account first.");
        }
        return aid;
    }
    /**
     * cTrader requires ACCOUNT_AUTH on the same TCP/TLS channel before trade/symbol/quote calls.
     * If we re-send it and cTrader responds "already authorized", treat it as OK.
     */
    async ensureAccountAuthorized(userId, env, accountId) {
        const accessToken = await this.resolveAccessToken(userId);
        const res = await this.ctrader.send("PROTO_OA_ACCOUNT_AUTH_REQ", { ctidTraderAccountId: accountId, accessToken }, 12000, { userId, env, accountId });
        const decoded = res?.decoded ?? res;
        const payloadName = res?.payloadName ?? decoded?.payloadType;
        if (payloadName === "PROTO_OA_ERROR_RES") {
            const desc = String(decoded?.description ?? decoded?.message ?? "");
            // This is the one you saw:
            // "ACCOUNT_AUTH_ERROR: Trading account is already authorized in this channel"
            if (desc.toLowerCase().includes("already authorized"))
                return;
            throw new Error(desc || "ACCOUNT_AUTH_ERROR");
        }
    }
    // ---------- APIs ----------
    async listAccounts(userId, envOverride) {
        await this.resolveEnv(userId, envOverride);
        const accessToken = await this.resolveAccessToken(userId);
        const res = await this.ctrader.send("PROTO_OA_GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_REQ", { accessToken }, 12000, { userId, env: envOverride });
        const decoded = res?.decoded ?? res;
        const accounts = Array.isArray(decoded?.ctidTraderAccount) ? decoded.ctidTraderAccount : [];
        return Object.freeze({ count: accounts.length, items: accounts });
    }
    async authorizeAccount(userId, accountId, envOverride) {
        const env = await this.resolveEnv(userId, envOverride);
        await this.ensureAccountAuthorized(userId, env, accountId);
        await this.store.setActiveAccountId(userId, accountId);
        await this.store.setEnv(userId, env);
        return Object.freeze({
            authorized: true,
            activeAccountId: accountId,
            response: { payloadType: "PROTO_OA_ACCOUNT_AUTH_RES", ctidTraderAccountId: String(accountId) },
        });
    }
    async listSymbols(userId, q, limit, envOverride) {
        const env = await this.resolveEnv(userId, envOverride);
        const accountId = await this.resolveAccountId(userId);
        await this.ensureAccountAuthorized(userId, env, accountId);
        // If hash is empty/missing → refresh from cTrader first
        const cnt = await this.symbolStore.count(userId, env, accountId);
        if (!cnt)
            await this.refreshSymbols(userId, env, accountId);
        const items = await this.symbolStore.search(userId, env, accountId, q, limit);
        return { activeAccountId: accountId, count: items.length, items };
    }
    async getQuote(userId, symbol, waitSeconds, envOverride) {
        const env = await this.resolveEnv(userId, envOverride);
        const accountId = await this.resolveAccountId(userId);
        await this.ensureAccountAuthorized(userId, env, accountId);
        const symbolId = await this.ensureSymbolId(userId, env, accountId, symbol);
        await this.ctrader.send("PROTO_OA_SUBSCRIBE_SPOTS_REQ", {
            ctidTraderAccountId: accountId,
            symbolId: [symbolId],
            subscribeToSpotTimestamp: true,
        }, 12000, { userId, env, accountId });
        if (!waitSeconds || waitSeconds <= 0) {
            const last = this.quotes.getLast(userId, env, accountId, symbolId);
            if (!last)
                throw new Error("No quote received yet. Try again with ?wait=5");
            return last;
        }
        return await this.quotes.waitForNext(userId, env, accountId, symbolId, Math.floor(waitSeconds * 1000));
    }
    async getAccountInfo(userId, envOverride) {
        const env = await this.resolveEnv(userId, envOverride);
        const accountId = await this.resolveAccountId(userId);
        await this.ensureAccountAuthorized(userId, env, accountId);
        const res = await this.ctrader.send("PROTO_OA_TRADER_REQ", { ctidTraderAccountId: accountId }, 12000, { userId, env, accountId });
        return res?.decoded ?? res;
    }
    async placeTrade(req) {
        const env = await this.resolveEnv(req.userId, req.env);
        const accountId = await this.resolveAccountId(req.userId, req.accountId);
        await this.ensureAccountAuthorized(req.userId, env, accountId);
        const symbolId = await this.ensureSymbolId(req.userId, env, accountId, req.symbol);
        const orderType = req.orderType.toUpperCase();
        const side = req.side.toUpperCase();
        if (side !== "BUY" && side !== "SELL")
            throw new Error("side must be BUY or SELL");
        // cTrader: volume in 0.01 units (1000 => 10.00). (Your current scaling is OK.)
        const volume = Math.round(req.volumeUnits * 100);
        if (!Number.isFinite(volume) || volume <= 0)
            throw new Error("volumeUnits must be > 0");
        const base = {
            ctidTraderAccountId: accountId,
            symbolId,
            orderType, // NOTE: will be coerced to enum number in ProtoRegistry patch below
            tradeSide: side, // same
            volume,
        };
        if (req.comment)
            base.comment = req.comment;
        if (req.label)
            base.label = req.label;
        if (orderType === "LIMIT") {
            if (req.limitPrice == null)
                throw new Error("limitPrice is required for LIMIT");
            base.limitPrice = req.limitPrice;
        }
        if (orderType === "STOP" || orderType === "STOP_LIMIT") {
            if (req.stopPrice == null)
                throw new Error("stopPrice is required for STOP/STOP_LIMIT");
            base.stopPrice = req.stopPrice;
        }
        if (orderType === "MARKET") {
            if (req.stopLoss != null || req.takeProfit != null) {
                throw new Error("For MARKET orders, stopLoss/takeProfit absolute prices are not allowed. Use stopLossDistance/takeProfitDistance.");
            }
            if (req.stopLossDistance != null)
                base.stopLossDistance = req.stopLossDistance;
            if (req.takeProfitDistance != null)
                base.takeProfitDistance = req.takeProfitDistance;
        }
        else {
            if (req.stopLoss != null)
                base.stopLoss = req.stopLoss;
            if (req.takeProfit != null)
                base.takeProfit = req.takeProfit;
        }
        const res = await this.ctrader.send("PROTO_OA_NEW_ORDER_REQ", base, 15000, {
            userId: req.userId,
            env,
            accountId,
        });
        const decoded = res?.decoded ?? res;
        const payloadName = res?.payloadName ?? decoded?.payloadType;
        // optional: fail fast instead of returning error response
        if (payloadName === "PROTO_OA_ERROR_RES") {
            const desc = String(decoded?.description ?? decoded?.message ?? "ORDER_ERROR");
            throw new Error(desc);
        }
        this.logger.info({ userId: req.userId, env, accountId, symbol: req.symbol, orderType, side }, "✅ Trade request sent");
        return {
            request: { ...req, accountId, env, symbolId },
            response: decoded,
        };
    }
    // ---------- helpers ----------
    async refreshSymbols(userId, env, accountId) {
        // requires account auth on same channel
        await this.ensureAccountAuthorized(userId, env, accountId);
        const res = await this.ctrader.send("PROTO_OA_SYMBOLS_LIST_REQ", { ctidTraderAccountId: accountId, includeArchivedSymbols: false }, 15000, { userId, env, accountId });
        const decoded = res?.decoded ?? res;
        const symbolsArr = Array.isArray(decoded?.symbol) ? decoded.symbol : [];
        const map = new Map();
        for (const s of symbolsArr) {
            const name = String(s.symbolName ?? s.name ?? "").toUpperCase().trim();
            const id = Number(s.symbolId);
            if (name && Number.isFinite(id))
                map.set(name, id);
        }
        await this.symbolStore.replaceAll(userId, env, accountId, map);
    }
    async ensureSymbolId(userId, env, accountId, symbol) {
        const sym = symbol.trim().toUpperCase();
        let id = await this.symbolStore.getSymbolId(userId, env, accountId, sym);
        if (id != null)
            return id;
        // refresh and retry once
        await this.refreshSymbols(userId, env, accountId);
        id = await this.symbolStore.getSymbolId(userId, env, accountId, sym);
        if (id == null)
            throw new Error(`Symbol not found: ${symbol}`);
        return id;
    }
}
