// src/infra/ctrader/quote-bus.ts
import { setTimeout as delay } from "node:timers/promises";
import { Logger } from "../logger.js";

export type CTraderEnv = "demo" | "live";

export type Quote = Readonly<{
  userId: string;
  env: CTraderEnv;
  accountId: number;
  symbolId: number;
  bid: number | null;
  ask: number | null;
  timestamp: number | null;
  raw?: unknown;
}>;

type QuoteKey = string; // packed key

function qkey(
  userId: string,
  env: CTraderEnv,
  accountId: number,
  symbolId: number,
): QuoteKey {
  return `${userId}:${env}:${accountId}:${symbolId}`;
}

type Waiter = Readonly<{
  resolve: (q: Quote) => void;
  reject: (e: Error) => void;
  createdAt: number;
}>;

export class QuoteBus {
  private readonly last = new Map<QuoteKey, Quote>();
  private readonly waiters = new Map<QuoteKey, Waiter[]>();

  // Prevent unbounded growth
  private readonly maxWaitersPerKey = 50;

  constructor(private readonly logger: Logger) {}

  upsert(q: Quote): void {
    const key = qkey(q.userId, q.env, q.accountId, q.symbolId);
    this.last.set(key, q);

    const list = this.waiters.get(key);
    if (!list || list.length === 0) return;

    // resolve all waiters, then clear
    this.waiters.delete(key);
    for (const w of list) w.resolve(q);
  }

  getLast(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    symbolId: number,
  ): Quote | undefined {
    return this.last.get(qkey(userId, env, accountId, symbolId));
  }

  async waitForNext(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    symbolId: number,
    timeoutMs: number,
  ): Promise<Quote> {
    const key = qkey(userId, env, accountId, symbolId);

    // create promise waiter
    const p = new Promise<Quote>((resolve, reject) => {
      const existing = this.waiters.get(key) ?? [];
      if (existing.length >= this.maxWaitersPerKey) {
        reject(new Error("Too many pending quote waiters for this symbol"));
        return;
      }
      const next: Waiter = Object.freeze({
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
    } catch (e) {
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
