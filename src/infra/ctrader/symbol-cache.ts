// src/infra/ctrader/symbol-cache.ts
export type CTraderEnv = "demo" | "live";

type Key = string;
function skey(userId: string, env: CTraderEnv, accountId: number): Key {
  return `${userId}:${env}:${accountId}`;
}

export class SymbolCache {
  private readonly map = new Map<Key, Map<string, number>>();
  private readonly updatedAt = new Map<Key, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(
    userId: string,
    env: CTraderEnv,
    accountId: number,
  ): Map<string, number> | undefined {
    const k = skey(userId, env, accountId);
    const t = this.updatedAt.get(k);
    if (!t) return undefined;
    if (Date.now() - t > this.ttlMs) return undefined;
    return this.map.get(k);
  }

  set(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    symbols: Map<string, number>,
  ): void {
    const k = skey(userId, env, accountId);
    this.map.set(k, symbols);
    this.updatedAt.set(k, Date.now());
  }
}
