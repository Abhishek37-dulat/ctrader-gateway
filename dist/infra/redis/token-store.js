export class TokenStore {
    constructor(redis, crypto) {
        this.redis = redis;
        this.crypto = crypto;
    }
    key(userId) {
        return `ctrader:session:${userId}`;
    }
    async loadSession(userId) {
        const raw = await this.redis.get(this.key(userId));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    async saveSession(userId, next, ttlSeconds) {
        const payload = JSON.stringify(next);
        if (ttlSeconds && ttlSeconds > 0) {
            await this.redis.set(this.key(userId), payload, { EX: ttlSeconds });
        }
        else {
            await this.redis.set(this.key(userId), payload);
        }
    }
    async patchSession(userId, patch, ttlSeconds) {
        const cur = (await this.loadSession(userId)) ?? {
            userId,
            updatedAt: Date.now(),
        };
        // IMPORTANT for exactOptionalPropertyTypes:
        // do NOT assign `env: undefined` etc. Only include fields if defined.
        const next = Object.freeze({
            userId,
            updatedAt: Date.now(),
            ...(cur.env !== undefined ? { env: cur.env } : {}),
            ...(cur.activeAccountId !== undefined
                ? { activeAccountId: cur.activeAccountId }
                : {}),
            ...(cur.accessTokenEnc !== undefined
                ? { accessTokenEnc: cur.accessTokenEnc }
                : {}),
            ...(cur.refreshTokenEnc !== undefined
                ? { refreshTokenEnc: cur.refreshTokenEnc }
                : {}),
            ...(patch.env !== undefined ? { env: patch.env } : {}),
            ...(patch.activeAccountId !== undefined
                ? { activeAccountId: patch.activeAccountId }
                : {}),
            ...(patch.accessTokenEnc !== undefined
                ? { accessTokenEnc: patch.accessTokenEnc }
                : {}),
            ...(patch.refreshTokenEnc !== undefined
                ? { refreshTokenEnc: patch.refreshTokenEnc }
                : {}),
        });
        await this.saveSession(userId, next, ttlSeconds);
        return next;
    }
    async setEnv(userId, env) {
        await this.patchSession(userId, { env });
    }
    async setActiveAccountId(userId, accountId) {
        await this.patchSession(userId, { activeAccountId: accountId });
    }
    async saveTokens(userId, tokens, ttlSeconds) {
        const accessTokenEnc = this.crypto.encrypt(tokens.accessToken);
        const refreshTokenEnc = tokens.refreshToken !== undefined
            ? this.crypto.encrypt(tokens.refreshToken)
            : undefined;
        await this.patchSession(userId, {
            accessTokenEnc,
            ...(refreshTokenEnc !== undefined ? { refreshTokenEnc } : {}),
        }, ttlSeconds);
    }
    async loadAccessToken(userId) {
        const s = await this.loadSession(userId);
        if (!s?.accessTokenEnc)
            return null;
        return this.crypto.decrypt(s.accessTokenEnc);
    }
    async loadRefreshToken(userId) {
        const s = await this.loadSession(userId);
        if (!s?.refreshTokenEnc)
            return null;
        return this.crypto.decrypt(s.refreshTokenEnc);
    }
}
