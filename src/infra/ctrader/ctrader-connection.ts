// src/infra/ctrader/ctrader-connection.ts
import net from "node:net";
import { env } from "../../config/env.js";
import type { Logger } from "../logger.js";
import { Wire } from "./protobuf/wire.js";
import type { ProtoRegistry } from "./protobuf/proto-registry.js";

export type CTraderEnv = "demo" | "live";

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timeout: NodeJS.Timeout;
};

export type SendMeta = Readonly<{
  userId?: string;
  env?: CTraderEnv;
  accountId?: number;
}>;

export class CTraderConnection {
  private socket: net.Socket | null = null;
  private acc: Buffer = Buffer.alloc(0);

  private connected = false;
  private appAuthed = false;

  private currentEnv: CTraderEnv = env.ctrader.env;

  private backoffMs = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private connectInFlight = false;
  private shuttingDown = false;

  private msgIdSeq = 1;
  private pending = new Map<string, Pending>();

  // readiness promise so callers can await auth
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    private readonly proto: ProtoRegistry,
  ) {}

  private hostFor(e: CTraderEnv): string {
    return e === "live" ? env.ctrader.liveHost : env.ctrader.demoHost;
  }

  async start(): Promise<void> {
    this.shuttingDown = false;
    await this.proto.load();
    await this.connect(env.ctrader.env);
    // do not await ready here; app will still boot, routes can call when needed
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this.connected = false;
    this.appAuthed = false;
    this.connectInFlight = false;

    this.failReady(new Error("Disconnected"));

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
  }

  isReady(): boolean {
    return this.connected && this.appAuthed;
  }

  /**
   * Ensures we are connected+authorized to the requested env.
   * If env differs, we reconnect to that env (single-connection design).
   */
  private async ensureReady(targetEnv: CTraderEnv): Promise<void> {
    if (this.shuttingDown) throw new Error("Shutting down");

    if (this.currentEnv !== targetEnv) {
      this.logger.warn(
        { from: this.currentEnv, to: targetEnv },
        "🔁 Switching cTrader env (reconnecting)",
      );
      await this.forceReconnect(targetEnv);
    }

    if (this.isReady()) return;
    // Wait until connect/auth finishes
    await this.readyPromise;
  }

  private resetReady(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private succeedReady(): void {
    if (this.readyResolve) this.readyResolve();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private failReady(err: Error): void {
    if (this.readyReject) this.readyReject(err);
    this.readyResolve = null;
    this.readyReject = null;
    this.resetReady();
  }

  // ---- Connection lifecycle ----

  private async forceReconnect(targetEnv: CTraderEnv): Promise<void> {
    // stop only socket (do not set shuttingDown)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this.connected = false;
    this.appAuthed = false;

    this.failPending(new Error("Disconnected"));
    this.failReady(new Error("Disconnected"));

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    await this.connect(targetEnv);
    await this.readyPromise; // wait for auth
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async connect(targetEnv: CTraderEnv): Promise<void> {
    if (this.connectInFlight || this.shuttingDown) return;

    this.connectInFlight = true;
    this.currentEnv = targetEnv;

    const host = this.hostFor(targetEnv);
    const port = env.ctrader.port;

    this.logger.info({ host, port, targetEnv }, "🔌 Connecting to cTrader...");

    // clean old socket (if any)
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    this.appAuthed = false;

    // reset readiness for this connection attempt
    this.resetReady();

    const sock = new net.Socket();
    this.socket = sock;

    sock.setNoDelay(true);

    sock.on("data", (chunk: Buffer) => this.onData(chunk));

    sock.on("error", (err: unknown) => {
      this.logger.error({ err }, "❌ TCP error");
    });

    sock.on("close", () => {
      this.logger.warn({}, "🔌 TCP closed");
      this.connected = false;
      this.appAuthed = false;
      this.connectInFlight = false;

      this.failPending(new Error("Disconnected"));
      this.failReady(new Error("Disconnected"));

      this.scheduleReconnect();
    });

    sock.on("connect", async () => {
      this.connected = true;
      this.backoffMs = 500;
      this.logger.info({ host, port }, `✅ Connected to ${host}:${port}`);

      try {
        await this.appAuth();
        this.appAuthed = true;
        this.connectInFlight = false;
        this.succeedReady();
        this.logger.info({}, "✅ Application authorized");
      } catch (e: unknown) {
        this.connectInFlight = false;
        this.logger.error({ err: e }, "❌ AppAuth failed");
        this.failReady(e instanceof Error ? e : new Error("AppAuth failed"));

        try {
          sock.destroy();
        } catch {}
        this.scheduleReconnect();
      }
    });

    sock.connect(port, host);
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    const wait = this.backoffMs;
    this.backoffMs = Math.min(30_000, Math.floor(this.backoffMs * 1.8));

    this.logger.warn({ waitMs: wait }, "⏳ Reconnecting...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // if another connect/auth still running, try later
      if (this.connectInFlight) {
        this.scheduleReconnect();
        return;
      }

      void this.connect(this.currentEnv);
    }, wait);
  }

  // ---- Send/Receive ----

  /**
   * Send a request. `meta` is optional and used for logging + env switching.
   */
  async send(
    payloadEnumKey: string,
    obj: any,
    timeoutMs = 12_000,
    meta?: SendMeta,
  ): Promise<any> {
    const targetEnv = meta?.env ?? env.ctrader.env;
    await this.ensureReady(targetEnv);

    if (!this.socket || !this.connected) throw new Error("Not connected");

    // ✅ allow AppAuth request before appAuthed is true
    const isAppAuth = payloadEnumKey === "PROTO_OA_APPLICATION_AUTH_REQ";
    if (!this.appAuthed && !isAppAuth) {
      throw new Error("App not authorized yet");
    }

    const payloadTypeId = this.proto.payloadTypeId(payloadEnumKey);
    const typeName = this.proto.messageTypeFromPayloadName(payloadEnumKey);

    const clientMsgId = String(this.nextMsgId());
    const reqObj = this.attachClientMsgId(typeName, obj, clientMsgId);

    const payloadBytes = this.proto.encodeMessage(typeName, reqObj);
    const wrapperBytes = this.proto.encodeProtoMessage(
      payloadTypeId,
      payloadBytes,
    );

    const framed = Wire.frame(wrapperBytes);

    // best-effort log
    this.logger.debug(
      {
        payloadEnumKey,
        clientMsgId,
        userId: meta?.userId,
        env: targetEnv,
        accountId: meta?.accountId,
      },
      "➡️ cTrader send",
    );

    this.socket.write(framed);

    return await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(
          new Error(
            `Request timeout (${payloadEnumKey}) clientMsgId=${clientMsgId}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(clientMsgId, { resolve, reject, timeout });
    });
  }

  private onData(chunk: Buffer): void {
    this.acc = Buffer.concat([this.acc, chunk]);
    const { frames, rest } = Wire.deframe(this.acc);
    this.acc = rest;

    for (const frame of frames) {
      try {
        const { payloadType, payload } = this.proto.decodeProtoMessage(frame);

        const payloadName = this.proto.payloadTypeName(payloadType);
        const typeName = this.proto.messageTypeFromPayloadName(payloadName);
        const decoded = this.proto.decodeMessage(typeName, payload);

        const id = this.extractClientMsgId(decoded);
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          clearTimeout(p.timeout);
          this.pending.delete(id);
          p.resolve({ payloadName, typeName, decoded });
          continue;
        }

        // async events (spot/order/error). You’ll route these later to QuoteBus.
        this.logger.debug({ payloadName }, "📩 event received");
      } catch (e: unknown) {
        this.logger.error({ err: e }, "❌ Failed to decode incoming frame");
      }
    }
  }

  // ---- AppAuth ----

  private async appAuth(): Promise<void> {
    // IMPORTANT: call send with AppAuth payloadEnumKey so it bypasses appAuthed guard
    const res = await this.send(
      "PROTO_OA_APPLICATION_AUTH_REQ",
      {
        clientId: env.ctrader.clientId,
        clientSecret: env.ctrader.clientSecret,
      },
      12_000,
      { env: this.currentEnv },
    );

    const payloadName = (res as any)?.payloadName;
    const decoded = (res as any)?.decoded;

    if (payloadName === "PROTO_OA_ERROR_RES") {
      const msg = decoded?.description || decoded?.message || "UNKNOWN";
      throw new Error(`AppAuth error: ${msg}`);
    }

    // If it isn't error, assume ok (ProtoOAApplicationAuthRes)
    if (!decoded) throw new Error("Empty auth response");
  }

  // ---- clientMsgId helpers ----

  private nextMsgId(): number {
    this.msgIdSeq += 1;
    if (this.msgIdSeq > 2_000_000_000) this.msgIdSeq = 1;
    return this.msgIdSeq;
  }

  private attachClientMsgId(
    typeName: string,
    obj: any,
    clientMsgId: string,
  ): any {
    if (this.proto.hasField(typeName, "clientMsgId")) {
      return { ...obj, clientMsgId };
    }
    return obj;
  }

  private extractClientMsgId(decoded: any): string | null {
    const v = decoded?.clientMsgId;
    if (v === undefined || v === null) return null;
    return String(v);
  }
}
