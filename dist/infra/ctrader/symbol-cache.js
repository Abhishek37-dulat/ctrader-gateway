function skey(userId, env, accountId) {
    return `${userId}:${env}:${accountId}`;
}
export class SymbolCache {
    constructor(ttlMs = 10 * 60 * 1000) {
        this.map = new Map();
        this.updatedAt = new Map();
        this.ttlMs = ttlMs;
    }
    get(userId, env, accountId) {
        const k = skey(userId, env, accountId);
        const t = this.updatedAt.get(k);
        if (!t)
            return undefined;
        if (Date.now() - t > this.ttlMs)
            return undefined;
        return this.map.get(k);
    }
    set(userId, env, accountId, symbols) {
        const k = skey(userId, env, accountId);
        this.map.set(k, symbols);
        this.updatedAt.set(k, Date.now());
    }
}
