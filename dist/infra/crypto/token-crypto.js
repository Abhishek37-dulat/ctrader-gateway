import crypto from "node:crypto";
function hexToKey32(hex) {
    const v = (hex || "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(v)) {
        throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Example: 64-char hex string.");
    }
    return Buffer.from(v, "hex");
}
export class TokenCrypto {
    constructor(tokenEncryptionKeyHex) {
        this.key = hexToKey32(tokenEncryptionKeyHex);
    }
    encrypt(plain) {
        const iv = crypto.randomBytes(12); // GCM recommended IV length
        const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from(plain, "utf8")),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, ciphertext]).toString("base64");
    }
    decrypt(payloadB64) {
        const buf = Buffer.from((payloadB64 || "").trim(), "base64");
        if (buf.length < 12 + 16) {
            throw new Error("Invalid encrypted payload (too short)");
        }
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const ciphertext = buf.subarray(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]);
        return plain.toString("utf8");
    }
}
