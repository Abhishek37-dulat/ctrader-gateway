// src/infra/redis/token-store.ts
import type { RedisClientType } from "redis";
import type { TokenCrypto } from "../crypto/token-crypto.js";

export type CTraderEnv = "demo" | "live";

export type Session = Readonly<{
  userId: string;
  env?: CTraderEnv;
  activeAccountId?: number;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  updatedAt: number;
}>;

export class TokenStore {
  constructor(
    private readonly redis: RedisClientType,
    private readonly crypto: TokenCrypto,
  ) {}

  private key(userId: string): string {
    return `ctrader:session:${userId}`;
  }

  async loadSession(userId: string): Promise<Session | null> {
    const raw = await this.redis.get(this.key(userId));
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  }

  private async saveSession(
    userId: string,
    next: Session,
    ttlSeconds?: number,
  ) {
    const payload = JSON.stringify(next);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(this.key(userId), payload, { EX: ttlSeconds });
    } else {
      await this.redis.set(this.key(userId), payload);
    }
  }

  async patchSession(
    userId: string,
    patch: Partial<Omit<Session, "userId" | "updatedAt">>,
    ttlSeconds?: number,
  ): Promise<Session> {
    const cur = (await this.loadSession(userId)) ?? {
      userId,
      updatedAt: Date.now(),
    };

    // IMPORTANT for exactOptionalPropertyTypes:
    // do NOT assign `env: undefined` etc. Only include fields if defined.
    const next: Session = Object.freeze({
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

  async setEnv(userId: string, env: CTraderEnv): Promise<void> {
    await this.patchSession(userId, { env });
  }

  async setActiveAccountId(userId: string, accountId: number): Promise<void> {
    await this.patchSession(userId, { activeAccountId: accountId });
  }

  async saveTokens(
    userId: string,
    tokens: { accessToken: string; refreshToken?: string },
    ttlSeconds: number,
  ): Promise<void> {
    const accessTokenEnc = this.crypto.encrypt(tokens.accessToken);
    const refreshTokenEnc =
      tokens.refreshToken !== undefined
        ? this.crypto.encrypt(tokens.refreshToken)
        : undefined;

    await this.patchSession(
      userId,
      {
        accessTokenEnc,
        ...(refreshTokenEnc !== undefined ? { refreshTokenEnc } : {}),
      },
      ttlSeconds,
    );
  }

  async loadAccessToken(userId: string): Promise<string | null> {
    const s = await this.loadSession(userId);
    if (!s?.accessTokenEnc) return null;
    return this.crypto.decrypt(s.accessTokenEnc);
  }

  async loadRefreshToken(userId: string): Promise<string | null> {
    const s = await this.loadSession(userId);
    if (!s?.refreshTokenEnc) return null;
    return this.crypto.decrypt(s.refreshTokenEnc);
  }
}
