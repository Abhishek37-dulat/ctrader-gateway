import tls from "node:tls";
import { env } from "../../config/env.js";
import { Wire } from "./protobuf/wire.js";
export class CTraderConnection {
    constructor(logger, proto) {
        this.logger = logger;
        this.proto = proto;
        this.socket = null;
        this.acc = Buffer.alloc(0);
        this.connected = false;
        this.appAuthed = false;
        this.currentEnv = env.ctrader.env;
        this.backoffMs = 500;
        this.reconnectTimer = null;
        this.connectInFlight = false;
        this.shuttingDown = false;
        this.msgIdSeq = 1;
        this.pending = new Map();
        this.readyResolve = null;
        this.readyReject = null;
        this.readyPromise = Promise.resolve();
        // ---- Heartbeat ----
        this.heartbeatTimer = null;
        this.heartbeatEveryMs = 9000;
    }
    hostFor(e) {
        return e === "live" ? env.ctrader.liveHost : env.ctrader.demoHost;
    }
    async start() {
        this.shuttingDown = false;
        await this.proto.load();
        await this.connect(env.ctrader.env);
    }
    async stop() {
        this.shuttingDown = true;
        this.stopHeartbeat();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
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
    isReady() {
        return this.connected && this.appAuthed;
    }
    async ensureReady(targetEnv) {
        if (this.shuttingDown)
            throw new Error("Shutting down");
        if (this.currentEnv !== targetEnv) {
            this.logger.warn({ from: this.currentEnv, to: targetEnv }, "🔁 Switching cTrader env (reconnecting)");
            await this.forceReconnect(targetEnv);
        }
        if (this.isReady())
            return;
        await this.readyPromise;
    }
    resetReady() {
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        this.readyPromise.catch((err) => {
            this.logger.warn({ err }, "readyPromise rejected");
        });
    }
    succeedReady() {
        if (this.readyResolve)
            this.readyResolve();
        this.readyResolve = null;
        this.readyReject = null;
    }
    failReady(err) {
        if (this.readyReject)
            this.readyReject(err);
        this.readyResolve = null;
        this.readyReject = null;
        this.resetReady();
    }
    // ---- Heartbeat helpers ----
    startHeartbeat() {
        this.stopHeartbeat();
        if (!this.isReady())
            return;
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatEveryMs);
        this.heartbeatTimer.unref?.();
        this.logger.debug({}, "💓 Heartbeat started");
    }
    stopHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
    sendHeartbeat() {
        if (this.shuttingDown)
            return;
        if (!this.socket || !this.connected || !this.appAuthed)
            return;
        try {
            const payloadEnumKey = "PROTO_HEARTBEAT_EVENT";
            const payloadTypeId = this.proto.payloadTypeId(payloadEnumKey);
            const typeName = this.proto.messageTypeFromPayloadName(payloadEnumKey);
            const payloadBytes = this.proto.encodeMessage(typeName, {
                payloadType: payloadTypeId,
            });
            // Heartbeat is one-way; no clientMsgId needed
            const wrapperBytes = this.proto.encodeProtoMessage(payloadTypeId, payloadBytes);
            const framed = Wire.frame(wrapperBytes);
            this.socket.write(framed);
            this.logger.debug({ payloadEnumKey }, "➡️ cTrader heartbeat");
        }
        catch (err) {
            this.logger.debug({ err }, "heartbeat encode/send failed");
        }
    }
    // ---- Connection lifecycle ----
    async forceReconnect(targetEnv) {
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.stopHeartbeat();
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
        await this.readyPromise;
    }
    failPending(err) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timeout);
            p.reject(err);
        }
        this.pending.clear();
    }
    async connect(targetEnv) {
        if (this.connectInFlight || this.shuttingDown)
            return;
        this.connectInFlight = true;
        this.currentEnv = targetEnv;
        const host = this.hostFor(targetEnv);
        const port = env.ctrader.port;
        this.logger.info({ host, port, targetEnv }, "🔌 Connecting to cTrader...");
        this.stopHeartbeat();
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.appAuthed = false;
        this.resetReady();
        const sock = tls.connect({
            host,
            port,
            servername: host,
        });
        this.socket = sock;
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 30000);
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("error", (err) => {
            this.stopHeartbeat();
            this.logger.error({ err }, "❌ TCP/TLS error");
            try {
                sock.destroy();
            }
            catch { }
        });
        sock.on("close", () => {
            this.stopHeartbeat();
            this.logger.warn({}, "🔌 TCP closed");
            this.connected = false;
            this.appAuthed = false;
            this.connectInFlight = false;
            this.failPending(new Error("Disconnected"));
            this.failReady(new Error("Disconnected"));
            this.scheduleReconnect();
        });
        sock.on("secureConnect", async () => {
            this.connected = true;
            this.backoffMs = 500;
            this.logger.info({ host, port }, `✅ TLS connected to ${host}:${port}`);
            try {
                await this.appAuth();
                this.appAuthed = true;
                this.connectInFlight = false;
                this.succeedReady();
                this.logger.info({}, "✅ Application authorized");
                this.startHeartbeat();
            }
            catch (e) {
                this.connectInFlight = false;
                this.logger.error({ err: e }, "❌ AppAuth failed");
                this.failReady(e instanceof Error ? e : new Error("AppAuth failed"));
                try {
                    sock.destroy();
                }
                catch { }
                this.scheduleReconnect();
            }
        });
    }
    scheduleReconnect() {
        if (this.shuttingDown)
            return;
        if (this.reconnectTimer)
            return;
        const wait = this.backoffMs;
        this.backoffMs = Math.min(30000, Math.floor(this.backoffMs * 1.8));
        this.logger.warn({ waitMs: wait }, "⏳ Reconnecting...");
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.connectInFlight) {
                this.scheduleReconnect();
                return;
            }
            void this.connect(this.currentEnv);
        }, wait);
    }
    // ---- Send/Receive ----
    async send(payloadEnumKey, obj, timeoutMs = 12000, meta) {
        const targetEnv = meta?.env ?? env.ctrader.env;
        const isAppAuth = payloadEnumKey === "PROTO_OA_APPLICATION_AUTH_REQ";
        if (!isAppAuth) {
            await this.ensureReady(targetEnv);
        }
        else {
            if (!this.socket || !this.connected) {
                throw new Error("Not connected");
            }
        }
        if (!this.socket || !this.connected) {
            throw new Error("Not connected");
        }
        const payloadTypeId = this.proto.payloadTypeId(payloadEnumKey);
        const typeName = this.proto.messageTypeFromPayloadName(payloadEnumKey);
        const clientMsgId = String(this.nextMsgId());
        const reqObj = this.attachClientMsgId(typeName, obj, clientMsgId);
        const payloadBytes = this.proto.encodeMessage(typeName, reqObj);
        // ✅ IMPORTANT: include clientMsgId in the ProtoMessage wrapper for correlation
        const wrapperBytes = this.proto.encodeProtoMessage(payloadTypeId, payloadBytes, clientMsgId);
        const framed = Wire.frame(wrapperBytes);
        this.logger.debug({
            payloadEnumKey,
            clientMsgId,
            userId: meta?.userId,
            env: targetEnv,
            accountId: meta?.accountId,
        }, "➡️ cTrader send");
        this.socket.write(framed);
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(clientMsgId);
                reject(new Error(`Request timeout (${payloadEnumKey}) clientMsgId=${clientMsgId}`));
            }, timeoutMs);
            this.pending.set(clientMsgId, { resolve, reject, timeout });
        });
    }
    onData(chunk) {
        this.acc = Buffer.concat([this.acc, chunk]);
        const { frames, rest } = Wire.deframe(this.acc);
        this.acc = rest;
        for (const frame of frames) {
            try {
                const { payloadType, payload, clientMsgId } = this.proto.decodeProtoMessage(frame);
                let payloadName;
                try {
                    payloadName = this.proto.payloadTypeName(payloadType);
                }
                catch {
                    this.logger.debug({ payloadType }, "📩 Received unknown payload type (likely heartbeat)");
                    continue;
                }
                const typeName = this.proto.messageTypeFromPayloadName(payloadName);
                const decoded = this.proto.decodeMessage(typeName, payload);
                // ✅ prefer wrapper clientMsgId; fallback to payload field
                const id = clientMsgId ?? this.extractClientMsgId(decoded);
                if (id && this.pending.has(id)) {
                    const p = this.pending.get(id);
                    clearTimeout(p.timeout);
                    this.pending.delete(id);
                    p.resolve({ payloadName, typeName, decoded });
                    continue;
                }
                // Handle system responses that might not echo clientMsgId
                if (payloadName === "PROTO_OA_APPLICATION_AUTH_RES" ||
                    payloadName === "PROTO_OA_ERROR_RES" ||
                    payloadName === "PROTO_OA_ACCOUNT_AUTH_RES") {
                    for (const [msgId, pending] of this.pending) {
                        clearTimeout(pending.timeout);
                        this.pending.delete(msgId);
                        pending.resolve({ payloadName, typeName, decoded });
                        this.logger.debug({ payloadName, matchedMsgId: msgId }, "📩 system response matched to pending request");
                        break;
                    }
                    continue;
                }
                this.logger.debug({ payloadName }, "📩 event received");
            }
            catch (e) {
                this.logger.error({ err: e }, "❌ Failed to decode incoming frame");
            }
        }
    }
    // ---- AppAuth ----
    async appAuth() {
        this.logger.info({}, "🔐 Sending AppAuth to cTrader");
        const res = await this.send("PROTO_OA_APPLICATION_AUTH_REQ", {
            clientId: env.ctrader.clientId,
            clientSecret: env.ctrader.clientSecret,
        }, 12000, { env: this.currentEnv });
        const payloadName = res?.payloadName;
        const decoded = res?.decoded;
        if (payloadName === "PROTO_OA_ERROR_RES") {
            const msg = decoded?.description || decoded?.message || "UNKNOWN";
            throw new Error(`AppAuth error: ${msg}`);
        }
        if (!decoded)
            throw new Error("Empty auth response");
    }
    // ---- clientMsgId helpers ----
    nextMsgId() {
        this.msgIdSeq += 1;
        if (this.msgIdSeq > 2000000000)
            this.msgIdSeq = 1;
        return this.msgIdSeq;
    }
    attachClientMsgId(typeName, obj, clientMsgId) {
        if (this.proto.hasField(typeName, "clientMsgId")) {
            return { ...obj, clientMsgId };
        }
        return obj;
    }
    extractClientMsgId(decoded) {
        const v = decoded?.clientMsgId;
        if (v === undefined || v === null)
            return null;
        return String(v);
    }
}
