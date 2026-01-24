// src/app.ts
import type { AppEnv } from "./config/env.js";
import type { Logger } from "./infra/logger.js";

import { RedisClient } from "./infra/redis/redis.client.js";
import { TokenCrypto } from "./infra/crypto/token-crypto.js";
import { TokenStore } from "./infra/redis/token-store.js";

import { ProtoRegistry } from "./infra/ctrader/protobuf/proto-registry.js";
import { QuoteBus } from "./infra/ctrader/quote-bus.js";
import { CTraderConnection } from "./infra/ctrader/ctrader-connection.js";
import { CTraderGateway } from "./infra/ctrader/ctrader-gateway.js";

import { OAuthService } from "./infra/oauth/oauth.service.js";
import { HttpServer } from "./infra/http/http-server.js";
import { registerRoutes } from "./infra/http/routes.js";

export class App {
  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.logger.info({}, "✅ App.start()");

    const redisClient = new RedisClient(this.env, this.logger);
    await redisClient.connect();
    this.logger.info({}, "✅ Redis connected");

    const crypto = new TokenCrypto(this.env.tokenEncryptionKey);
    const store = new TokenStore(redisClient.redis, crypto);

    const proto = new ProtoRegistry(this.logger);
    await proto.load();
    this.logger.info({}, "✅ Protobuf loaded");

    const quotes = new QuoteBus(this.logger);

    // if your CTraderConnection signature is (logger, proto)
    // keep it; if it's (logger, proto, quotes), then pass quotes.
    const ctraderConn = new CTraderConnection(this.logger, proto);
    await ctraderConn.start();
    this.logger.info({}, "✅ cTrader connection started");

    const oauth = new OAuthService(this.env, store, this.logger);
    const gateway = new CTraderGateway(store, ctraderConn, quotes, this.logger);

    const server = new HttpServer(this.env, this.logger);
    registerRoutes(server.app, { oauth, gateway, logger: this.logger });

    await server.listen();
    this.logger.info({ port: this.env.port }, "✅ HTTP listening");
  }
}
