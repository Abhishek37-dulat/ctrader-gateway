import { Buffer } from "node:buffer";
function requireStr(name) {
    const v = process.env[name];
    if (!v || !v.trim())
        throw new Error(`Missing env: ${name}`);
    return v.trim();
}
function optStr(name) {
    const v = process.env[name];
    const t = v?.trim();
    return t ? t : undefined;
}
function parsePort(name, fallback) {
    const raw = process.env[name];
    const v = raw ? Number(raw) : fallback;
    if (!v || !Number.isInteger(v) || v < 1 || v > 65535) {
        throw new Error(`Invalid ${name} (must be 1..65535)`);
    }
    return v;
}
function asOneOf(name, v, allowed) {
    if (allowed.includes(v))
        return v;
    throw new Error(`Invalid ${name}. Allowed: ${allowed.join(", ")}`);
}
function validateTokenKeyHex32(name, v) {
    // 32 bytes hex = 64 chars
    if (!/^[0-9a-fA-F]{64}$/.test(v)) {
        throw new Error(`${name} must be 64 hex chars (32 bytes).`);
    }
}
export class Env {
    static load() {
        const nodeEnv = asOneOf("NODE_ENV", (process.env.NODE_ENV ?? "development").trim(), ["development", "test", "production"]);
        const port = parsePort("PORT", 8088);
        const ctraderEnv = asOneOf("CTRADER_ENV", (process.env.CTRADER_ENV ?? "demo").trim().toLowerCase(), ["demo", "live"]);
        const logLevel = asOneOf("LOG_LEVEL", (process.env.LOG_LEVEL ?? (nodeEnv === "development" ? "debug" : "info")).trim(), ["fatal", "error", "warn", "info", "debug", "trace"]);
        const tokenEncryptionKey = requireStr("TOKEN_ENCRYPTION_KEY");
        validateTokenKeyHex32("TOKEN_ENCRYPTION_KEY", tokenEncryptionKey);
        const envObj = Object.freeze({
            nodeEnv,
            port,
            ctrader: Object.freeze({
                clientId: requireStr("CTRADER_CLIENT_ID"),
                clientSecret: requireStr("CTRADER_CLIENT_SECRET"),
                redirectUri: requireStr("CTRADER_REDIRECT_URI"),
                env: ctraderEnv,
                demoHost: (process.env.CTRADER_DEMO_HOST ?? "demo.ctraderapi.com").trim(),
                liveHost: (process.env.CTRADER_LIVE_HOST ?? "live.ctraderapi.com").trim(),
                port: parsePort("CTRADER_PORT", 5035),
            }),
            redisUrl: requireStr("REDIS_URL"),
            tokenEncryptionKey,
            internalApiKey: optStr("INTERNAL_API_KEY"),
            logLevel,
        });
        return envObj;
    }
}
/**
 * ✅ Singleton runtime env you can import everywhere.
 * This solves: "no exported member named env"
 */
export const env = Env.load();
export function decodeKey32(value) {
    const v = value.trim();
    // hex 32 bytes => 64 chars
    if (/^[0-9a-fA-F]{64}$/.test(v)) {
        return Buffer.from(v, "hex");
    }
    // base64 32 bytes
    const b = Buffer.from(v, "base64");
    if (b.length === 32)
        return b;
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex64 or base64)");
}
