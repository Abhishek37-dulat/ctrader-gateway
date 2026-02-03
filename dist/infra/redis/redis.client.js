import { createClient } from "redis";
export class RedisClient {
    constructor(env, logger) {
        this.env = env;
        this.logger = logger;
        this.redis = createClient({ url: this.env.redisUrl });
        this.redis.on("error", (err) => {
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
    async connect() {
        if (this.redis.isOpen)
            return;
        await this.redis.connect();
    }
    async disconnect() {
        if (!this.redis.isOpen)
            return;
        await this.redis.quit();
    }
    async get(key) {
        return this.redis.get(key);
    }
    async set(key, value, ttlSeconds) {
        if (ttlSeconds && ttlSeconds > 0) {
            await this.redis.set(key, value, { EX: ttlSeconds });
            return;
        }
        await this.redis.set(key, value);
    }
    async del(key) {
        return this.redis.del(key);
    }
    async jsonGet(key) {
        const raw = await this.get(key);
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    async jsonSet(key, obj, ttlSeconds) {
        await this.set(key, JSON.stringify(obj), ttlSeconds);
    }
}
