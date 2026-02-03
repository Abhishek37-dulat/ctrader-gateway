import { createClient, type RedisClientType } from "redis";
import type { Logger } from "../logger.js";
import type { AppEnv } from "../../config/env.js";

export class RedisClient {
  public readonly redis: RedisClientType;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
  ) {
    this.redis = createClient({ url: this.env.redisUrl });

    this.redis.on("error", (err:unknown) => {
      this.logger.error({ err }, "❌ Redis error");
    });

    this.redis.on("connect", () => {
      this.logger.info({}, "🔌 Redis connecting...");
    });

    this.redis.on("ready", () => {
      this.logger.info({}, "✅ Redis connected");
    });

    this.redis.on("end", () => {
      this.logger.warn({}, "🔌 Redis connection closed");
    });
  }

  async connect(): Promise<void> {
    if (this.redis.isOpen) return;
    await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    if (!this.redis.isOpen) return;
    await this.redis.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(key, value, { EX: ttlSeconds });
      return;
    }
    await this.redis.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.redis.del(key);
  }

  async jsonGet<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  async jsonSet(key: string, obj: unknown, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(obj), ttlSeconds);
  }
}
