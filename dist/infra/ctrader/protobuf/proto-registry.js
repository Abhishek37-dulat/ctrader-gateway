import path from "path";
import protobuf from "protobufjs";
export class ProtoRegistry {
    constructor() { }
    async load() {
        const protoDir = path.resolve(process.cwd(), "proto");
        const files = [
            path.join(protoDir, "OpenApiCommonMessages.proto"),
            path.join(protoDir, "OpenApiCommonModelMessages.proto"),
            path.join(protoDir, "OpenApiMessages.proto"),
            path.join(protoDir, "OpenApiModelMessages.proto"),
        ];
        const root = new protobuf.Root();
        root.resolvePath = (_origin, target) => {
            if (path.isAbsolute(target))
                return target;
            return path.join(protoDir, target);
        };
        await root.load(files, { keepCase: true });
        root.resolveAll();
        this.root = root;
        const typesCount = this.countAllTypes();
        if (typesCount === 0) {
            throw new Error(`No protobuf Types were loaded. This usually means proto files failed to parse.\nLoaded from: ${protoDir}`);
        }
        this.protoMessageType = this.findTypeBySuffix("ProtoMessage");
        this.payloadEnum = this.findEnumBySuffix("ProtoOAPayloadType");
    }
    // Wrapper message ProtoMessage
    encodeProtoMessage(payloadTypeId, payloadBytes, clientMsgId) {
        const obj = {
            payloadType: payloadTypeId,
            payload: payloadBytes,
        };
        // IMPORTANT: Open API uses optional string clientMsgId for request/response correlation
        if (clientMsgId)
            obj.clientMsgId = String(clientMsgId);
        return this.protoMessageType.encode(this.protoMessageType.create(obj)).finish();
    }
    decodeProtoMessage(bytes) {
        const msg = this.protoMessageType.decode(bytes);
        const obj = this.protoMessageType.toObject(msg, {
            longs: String,
            enums: String,
            bytes: Buffer,
            defaults: true,
        });
        const payloadType = Number(obj.payloadType);
        const payload = obj.payload instanceof Uint8Array ? obj.payload : new Uint8Array(obj.payload);
        const clientMsgId = obj.clientMsgId ? String(obj.clientMsgId) : undefined;
        return { payloadType, payload, clientMsgId, raw: obj };
    }
    payloadTypeName(id) {
        for (const [k, v] of Object.entries(this.payloadEnum.values)) {
            if (v === id)
                return k;
        }
        throw new Error(`Unknown payloadType id=${id}`);
    }
    payloadTypeId(name) {
        let v = this.payloadEnum.values[name];
        if (v === undefined) {
            const alias = ProtoRegistry.PAYLOAD_ALIASES[name];
            if (alias)
                v = this.payloadEnum.values[alias];
        }
        if (v === undefined) {
            const needle = String(name).toUpperCase();
            const suggestions = Object.keys(this.payloadEnum.values)
                .filter((k) => k.includes(needle) || needle.includes(k))
                .slice(0, 10);
            throw new Error(`PayloadType not found: ${name}${suggestions.length ? ` | did you mean: ${suggestions.join(", ")}` : ""}`);
        }
        return v;
    }
    messageTypeFromPayloadName(payloadEnumKey) {
        const clean = payloadEnumKey.replace(/^PROTO_/, "");
        const parts = clean.split("_").filter(Boolean);
        let out = "Proto";
        for (const p of parts) {
            if (p === "OA")
                out += "OA";
            else
                out += p.charAt(0) + p.slice(1).toLowerCase();
        }
        return out;
    }
    hasField(typeName, fieldName) {
        const t = this.findType(typeName);
        return Boolean(t.fields[fieldName]);
    }
    decodeMessage(typeName, bytes) {
        const t = this.findType(typeName);
        const msg = t.decode(bytes);
        return t.toObject(msg, {
            longs: String,
            enums: String,
            bytes: String,
            defaults: true,
        });
    }
    // ---- find helpers ----
    findType(typeName) {
        // 1) exact lookup
        try {
            return this.root.lookupType(typeName);
        }
        catch {
            // 2) exact alias lookup
            const alias = ProtoRegistry.TYPE_ALIASES[typeName];
            if (alias) {
                try {
                    return this.root.lookupType(alias);
                }
                catch {
                    // fallthrough
                }
            }
            // 3) suffix lookup for alias, then original
            if (alias) {
                try {
                    return this.findTypeBySuffix(alias);
                }
                catch {
                    // ignore
                }
            }
            return this.findTypeBySuffix(typeName);
        }
    }
    findTypeBySuffix(suffix) {
        const found = this.findAnySuffix(suffix, "Type");
        if (!(found instanceof protobuf.Type))
            throw new Error(`Protobuf not found Type: ${suffix}`);
        return found;
    }
    findEnumBySuffix(suffix) {
        const found = this.findAnySuffix(suffix, "Enum");
        if (!(found instanceof protobuf.Enum))
            throw new Error(`Protobuf not found Enum: ${suffix}`);
        return found;
    }
    findAnySuffix(suffix, kind) {
        const stack = [this.root];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur)
                continue;
            if (kind === "Type" && cur instanceof protobuf.Type && cur.fullName?.endsWith(suffix))
                return cur;
            if (kind === "Enum" && cur instanceof protobuf.Enum && cur.fullName?.endsWith(suffix))
                return cur;
            const nested = cur.nested;
            if (nested && typeof nested === "object") {
                for (const v of Object.values(nested))
                    stack.push(v);
            }
        }
        throw new Error(`Protobuf not found: ${suffix}`);
    }
    countAllTypes() {
        let count = 0;
        const stack = [this.root];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur)
                continue;
            if (cur instanceof protobuf.Type)
                count++;
            const nested = cur.nested;
            if (nested && typeof nested === "object") {
                for (const v of Object.values(nested))
                    stack.push(v);
            }
        }
        return count;
    }
    coerceEnums(type, obj) {
        if (!obj || typeof obj !== "object")
            return obj;
        const out = { ...obj };
        for (const [fieldName, field] of Object.entries(type.fields)) {
            const v = out[fieldName];
            if (v == null)
                continue;
            const resolved = field.resolvedType;
            const isEnum = resolved instanceof protobuf.Enum;
            if (!isEnum)
                continue;
            // single enum field
            if (typeof v === "string") {
                const mapped = resolved.values?.[v];
                if (mapped !== undefined)
                    out[fieldName] = mapped;
            }
            // repeated enum field
            if (Array.isArray(v)) {
                out[fieldName] = v.map((x) => {
                    if (typeof x !== "string")
                        return x;
                    const mapped = resolved.values?.[x];
                    return mapped !== undefined ? mapped : x;
                });
            }
        }
        return out;
    }
    encodeMessage(typeName, obj) {
        const t = this.findType(typeName);
        const coerced = this.coerceEnums(t, obj);
        return t.encode(t.create(coerced)).finish();
    }
}
// ---- payload enum aliases (enum key differences) ----
ProtoRegistry.PAYLOAD_ALIASES = {
    // Your code uses this (singular), but payload enum is plural:
    PROTO_OA_GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_REQ: "PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ",
    PROTO_OA_GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_RES: "PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES",
};
// ---- protobuf TYPE name aliases (message type differences) ----
ProtoRegistry.TYPE_ALIASES = {
    ProtoOAGetAccountsByAccessTokenReq: "ProtoOAGetAccountListByAccessTokenReq",
    ProtoOAGetAccountsByAccessTokenRes: "ProtoOAGetAccountListByAccessTokenRes",
};
