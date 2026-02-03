// src/infra/ctrader/quote-bus.ts
import { setTimeout as delay } from "node:timers/promises";
function qkey(userId, env, accountId, symbolId) {
    return `${userId}:${env}:${accountId}:${symbolId}`;
}
export class QuoteBus {
    constructor() {
        this.last = new Map();
        this.waiters = new Map();
        // Prevent unbounded growth
        this.maxWaitersPerKey = 50;
    }
    upsert(q) {
        const key = qkey(q.userId, q.env, q.accountId, q.symbolId);
        this.last.set(key, q);
        const list = this.waiters.get(key);
        if (!list || list.length === 0)
            return;
        // resolve all waiters, then clear
        this.waiters.delete(key);
        for (const w of list)
            w.resolve(q);
    }
    getLast(userId, env, accountId, symbolId) {
        return this.last.get(qkey(userId, env, accountId, symbolId));
    }
    async waitForNext(userId, env, accountId, symbolId, timeoutMs) {
        const key = qkey(userId, env, accountId, symbolId);
        // create promise waiter
        const p = new Promise((resolve, reject) => {
            const existing = this.waiters.get(key) ?? [];
            if (existing.length >= this.maxWaitersPerKey) {
                reject(new Error("Too many pending quote waiters for this symbol"));
                return;
            }
            const next = Object.freeze({
                resolve,
                reject,
                createdAt: Date.now(),
            });
            this.waiters.set(key, [...existing, next]);
        });
        // race with timeout
        try {
            const winner = await Promise.race([
                p,
                (async () => {
                    await delay(timeoutMs);
                    throw new Error("QUOTE_TIMEOUT");
                })(),
            ]);
            return winner;
        }
        catch (e) {
            // remove this waiter (best-effort)
            const list = this.waiters.get(key);
            if (list && list.length) {
                // cannot easily match the exact waiter reference here, so do nothing
                // (resolved waiters already removed; timeouts will be cleared by next quote)
            }
            throw e;
        }
    }
}
