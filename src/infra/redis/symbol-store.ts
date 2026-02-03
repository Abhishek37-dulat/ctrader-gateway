// src/infra/redis/symbol-store.ts
import type { CTraderEnv } from "../../config/env.js";

type RedisLike = any;

function toUtf8(x: any): string {
  if (x == null) return "";
  // Buffer / Uint8Array
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) return x.toString("utf8");
  if (x instanceof Uint8Array) return Buffer.from(x).toString("utf8");
  return String(x);
}

function toNum(x: any): number | null {
  const s = toUtf8(x).trim();
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeHscan(res: any): { cursor: string; pairs: Array<[any, any]> } {
  // ioredis: [cursor, [f1,v1,f2,v2,...]]
  if (Array.isArray(res) && res.length >= 2) {
    const cursor = toUtf8(res[0]);
    const raw = res[1];

    // sometimes raw is object map
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const pairs = Object.entries(raw) as any;
      return { cursor, pairs };
    }

    // normal flat tuples
    const tuples: any[] = Array.isArray(raw) ? raw : [];
    const pairs: Array<[any, any]> = [];
    for (let i = 0; i < tuples.length; i += 2) {
      pairs.push([tuples[i], tuples[i + 1]]);
    }
    return { cursor, pairs };
  }

  // node-redis style: { cursor, tuples } (tuples may be [[f,v],...] OR [f,v,f,v,...])
  if (res && typeof res === "object") {
    const cursor = toUtf8(res.cursor ?? "0");

    const tuples = res.tuples ?? res.entries ?? res.elements ?? res.items ?? null;

    // already pairs
    if (Array.isArray(tuples) && tuples.length && Array.isArray(tuples[0])) {
      return { cursor, pairs: tuples as Array<[any, any]> };
    }

    // flat list
    if (Array.isArray(tuples)) {
      const pairs: Array<[any, any]> = [];
      for (let i = 0; i < tuples.length; i += 2) pairs.push([tuples[i], tuples[i + 1]]);
      return { cursor, pairs };
    }

    // map/object
    if (tuples && typeof tuples === "object") {
      return { cursor, pairs: Object.entries(tuples) as any };
    }

    // some clients return { cursor, value: { field: val } }
    const value = res.value ?? res.results ?? null;
    if (value && typeof value === "object") {
      return { cursor, pairs: Object.entries(value) as any };
    }

    return { cursor, pairs: [] };
  }

  return { cursor: "0", pairs: [] };
}

export class SymbolStore {
  private readonly ttlSeconds: number;

  constructor(private readonly redis: RedisLike, opts?: { ttlSeconds?: number }) {
    this.ttlSeconds = opts?.ttlSeconds ?? 24 * 60 * 60;
  }

  key(userId: string, env: CTraderEnv, accountId: number): string {
    return `ctrader:symbols:${userId}:${env}:${accountId}`;
  }

  async count(userId: string, env: CTraderEnv, accountId: number): Promise<number> {
    const k = this.key(userId, env, accountId);
    const n =
      typeof this.redis.hlen === "function"
        ? await this.redis.hlen(k)
        : typeof this.redis.hLen === "function"
          ? await this.redis.hLen(k)
          : null;

    if (n != null) return Number(n) || 0;

    const all = await this.getAll(userId, env, accountId);
    return Object.keys(all).length;
  }

  async getSymbolId(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    symbol: string,
  ): Promise<number | null> {
    const k = this.key(userId, env, accountId);
    const field = symbol.trim().toUpperCase();

    const v =
      typeof this.redis.hget === "function"
        ? await this.redis.hget(k, field)
        : typeof this.redis.hGet === "function"
          ? await this.redis.hGet(k, field)
          : null;

    return toNum(v);
  }

  async replaceAll(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    map: Map<string, number>,
  ): Promise<void> {
    const k = this.key(userId, env, accountId);

    if (typeof this.redis.del === "function") await this.redis.del(k);

    // write new
    if (map.size) {
      // safest universal form: HSET key field value field value...
      const args: any[] = [];
      for (const [sym, id] of map.entries()) {
        args.push(sym, String(id));
      }

      if (typeof this.redis.hset === "function") {
        await this.redis.hset(k, ...args);
      } else if (typeof this.redis.hSet === "function") {
        // node-redis prefers object
        const obj: Record<string, string> = {};
        for (let i = 0; i < args.length; i += 2) obj[String(args[i])] = String(args[i + 1]);
        await this.redis.hSet(k, obj);
      }
    }

    if (this.ttlSeconds > 0) {
      if (typeof this.redis.expire === "function") await this.redis.expire(k, this.ttlSeconds);
    }
  }

  async search(
    userId: string,
    env: CTraderEnv,
    accountId: number,
    needleRaw: string,
    limit: number,
  ): Promise<Array<{ symbol: string; symbolId: number }>> {
    const k = this.key(userId, env, accountId);
    const needle = (needleRaw ?? "").trim().toUpperCase();
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;

    const out: Array<{ symbol: string; symbolId: number }> = [];

    const canHscan = typeof this.redis.hscan === "function" || typeof this.redis.hScan === "function";
    if (canHscan) {
      let cursor: any = "0";
      const match = needle ? `*${needle}*` : "*";

      while (true) {
        const res =
          typeof this.redis.hscan === "function"
            ? await this.redis.hscan(k, cursor, "MATCH", match, "COUNT", 200)
            : await this.redis.hScan(k, cursor, { MATCH: match, COUNT: 200 });

        const norm = normalizeHscan(res);
        cursor = norm.cursor;

        for (const [f, v] of norm.pairs) {
          const field = toUtf8(f);
          const id = toNum(v);
          if (!field || !id) continue;
          out.push({ symbol: field, symbolId: id });
          if (out.length >= safeLimit) return out;
        }

        if (String(cursor) === "0") break;
      }

      // If HSCAN yielded nothing but the hash has data, fallback to HGETALL (parsing issue / client quirk)
      if (!out.length) {
        const all = await this.getAll(userId, env, accountId);
        for (const [sym, val] of Object.entries(all)) {
          if (needle && !sym.toUpperCase().includes(needle)) continue;
          const id = toNum(val);
          if (!id) continue;
          out.push({ symbol: sym, symbolId: id });
          if (out.length >= safeLimit) break;
        }
      }

      return out;
    }

    // No HSCAN available -> fallback
    const all = await this.getAll(userId, env, accountId);
    for (const [sym, val] of Object.entries(all)) {
      if (needle && !sym.toUpperCase().includes(needle)) continue;
      const id = toNum(val);
      if (!id) continue;
      out.push({ symbol: sym, symbolId: id });
      if (out.length >= safeLimit) break;
    }
    return out;
  }

  private async getAll(
    userId: string,
    env: CTraderEnv,
    accountId: number,
  ): Promise<Record<string, any>> {
    const k = this.key(userId, env, accountId);

    if (typeof this.redis.hgetall === "function") return await this.redis.hgetall(k);
    if (typeof this.redis.hGetAll === "function") return await this.redis.hGetAll(k);
    return {};
  }
}
