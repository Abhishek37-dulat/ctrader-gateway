// src/infra/oauth/oauth.service.ts
import type { AppEnv } from "../../config/env.js";
import type { Logger } from "../logger.js";
import type { TokenStore } from "../redis/token-store.js";

export type OAuthTokens = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType?: string;
}>;

export class OAuthService {
  private readonly tokenUrl = "https://openapi.ctrader.com/apps/token";

  constructor(
    private readonly env: AppEnv,
    private readonly store: TokenStore,
    private readonly logger: Logger,
  ) {}

  async exchangeCodeAndStore(
    userId: string,
    code: string,
  ): Promise<OAuthTokens> {
    if (!code?.trim()) throw new Error("code is required");

    const tokens = await this.exchangeCode(code.trim());

    await this.store.saveTokens(
      userId,
      {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      },
      Math.max(60, tokens.expiresIn),
    );

    this.logger.info(
      { userId, expiresIn: tokens.expiresIn },
      "✅ OAuth code exchanged + tokens stored",
    );

    return tokens;
  }

  async refreshAndStore(userId: string): Promise<OAuthTokens> {
    const refresh = await this.store.loadRefreshToken(userId);
    if (!refresh)
      throw new Error("No refresh token in store. Exchange code first.");

    const tokens = await this.refresh(refresh);

    await this.store.saveTokens(
      userId,
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? refresh,
      },
      Math.max(60, tokens.expiresIn),
    );

    this.logger.info(
      { userId, expiresIn: tokens.expiresIn },
      "✅ OAuth refreshed + tokens stored",
    );

    return tokens;
  }

  private async exchangeCode(code: string): Promise<OAuthTokens> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("client_id", this.env.ctrader.clientId);
    body.set("client_secret", this.env.ctrader.clientSecret);
    body.set("redirect_uri", this.env.ctrader.redirectUri);

    const json = await this.postForm(this.tokenUrl, body);
    return this.normalizeTokens(json);
  }

  private async refresh(refreshToken: string): Promise<OAuthTokens> {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    body.set("client_id", this.env.ctrader.clientId);
    body.set("client_secret", this.env.ctrader.clientSecret);

    const json = await this.postForm(this.tokenUrl, body);
    return this.normalizeTokens(json);
  }

  private async postForm(url: string, body: URLSearchParams): Promise<any> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text };
    }

    if (!res.ok || json?.errorCode) {
      const msg = json?.description || json?.message || `HTTP ${res.status}`;
      throw new Error(`OAuth token error: ${msg}`);
    }

    return json;
  }

  private normalizeTokens(raw: any): OAuthTokens {
    const accessToken = String(
      raw.accessToken || raw.access_token || "",
    ).trim();
    const refreshToken = raw.refreshToken || raw.refresh_token;
    const expiresIn = Number(raw.expiresIn || raw.expires_in || 0);

    if (!accessToken) throw new Error("OAuth response missing access_token");
    if (!Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new Error("OAuth response missing expires_in");

    return Object.freeze({
      accessToken,
      ...(refreshToken ? { refreshToken: String(refreshToken) } : {}),
      expiresIn,
      ...(raw.tokenType ? { tokenType: String(raw.tokenType) } : {}),
    });
  }
}
