import path from "path";
import protobuf from "protobufjs";

type AnyNested = Record<string, unknown> & { nested?: Record<string, unknown> };

export class ProtoRegistry {
  public root!: protobuf.Root;

  constructor() {}

  private payloadEnum!: protobuf.Enum;
  private protoMessageType!: protobuf.Type;

  // ---- payload enum aliases (enum key differences) ----
  private static readonly PAYLOAD_ALIASES: Record<string, string> = {
    // Your code uses this (singular), but payload enum is plural:
    PROTO_OA_GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_REQ:
      "PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ",
    PROTO_OA_GET_ACCOUNT_LIST_BY_ACCESS_TOKEN_RES:
      "PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES",
  };

  // ---- protobuf TYPE name aliases (message type differences) ----
  private static readonly TYPE_ALIASES: Record<string, string> = {
    ProtoOAGetAccountsByAccessTokenReq: "ProtoOAGetAccountListByAccessTokenReq",
    ProtoOAGetAccountsByAccessTokenRes: "ProtoOAGetAccountListByAccessTokenRes",
  };

  async load(): Promise<void> {
    const protoDir = path.resolve(process.cwd(), "proto");
    const files = [
      path.join(protoDir, "OpenApiCommonMessages.proto"),
      path.join(protoDir, "OpenApiCommonModelMessages.proto"),
      path.join(protoDir, "OpenApiMessages.proto"),
      path.join(protoDir, "OpenApiModelMessages.proto"),
    ];

    const root = new protobuf.Root();

    root.resolvePath = (_origin: string, target: string): string => {
      if (path.isAbsolute(target)) return target;
      return path.join(protoDir, target);
    };

    await root.load(files, { keepCase: true });
    root.resolveAll();

    this.root = root;

    const typesCount = this.countAllTypes();
    if (typesCount === 0) {
      throw new Error(
        `No protobuf Types were loaded. This usually means proto files failed to parse.\nLoaded from: ${protoDir}`,
      );
    }

    this.protoMessageType = this.findTypeBySuffix("ProtoMessage");
    this.payloadEnum = this.findEnumBySuffix("ProtoOAPayloadType");
  }

  // Wrapper message ProtoMessage
  encodeProtoMessage(
    payloadTypeId: number,
    payloadBytes: Uint8Array,
    clientMsgId?: string,
  ): Uint8Array {
    const obj: Record<string, unknown> = {
      payloadType: payloadTypeId,
      payload: payloadBytes,
    };

    // IMPORTANT: Open API uses optional string clientMsgId for request/response correlation
    if (clientMsgId) obj.clientMsgId = String(clientMsgId);

    return this.protoMessageType.encode(this.protoMessageType.create(obj)).finish();
  }

  decodeProtoMessage(bytes: Uint8Array): {
    payloadType: number;
    payload: Uint8Array;
    clientMsgId?: string;
    raw: unknown;
  } {
    const msg = this.protoMessageType.decode(bytes);
    const obj = this.protoMessageType.toObject(msg, {
      longs: String,
      enums: String,
      bytes: Buffer,
      defaults: true,
    }) as {
      payloadType: number | string;
      payload: Buffer | Uint8Array;
      clientMsgId?: string;
    };

    const payloadType = Number(obj.payloadType);
    const payload = obj.payload instanceof Uint8Array ? obj.payload : new Uint8Array(obj.payload);

    const clientMsgId = obj.clientMsgId ? String(obj.clientMsgId) : undefined;

    return { payloadType, payload, clientMsgId, raw: obj };
  }

  payloadTypeName(id: number): string {
    for (const [k, v] of Object.entries(this.payloadEnum.values)) {
      if (v === id) return k;
    }
    throw new Error(`Unknown payloadType id=${id}`);
  }

  payloadTypeId(name: string): number {
    let v = this.payloadEnum.values[name];

    if (v === undefined) {
      const alias = ProtoRegistry.PAYLOAD_ALIASES[name];
      if (alias) v = this.payloadEnum.values[alias];
    }

    if (v === undefined) {
      const needle = String(name).toUpperCase();
      const suggestions = Object.keys(this.payloadEnum.values)
        .filter((k) => k.includes(needle) || needle.includes(k))
        .slice(0, 10);

      throw new Error(
        `PayloadType not found: ${name}${
          suggestions.length ? ` | did you mean: ${suggestions.join(", ")}` : ""
        }`,
      );
    }

    return v as number;
  }

  messageTypeFromPayloadName(payloadEnumKey: string): string {
    const clean = payloadEnumKey.replace(/^PROTO_/, "");
    const parts = clean.split("_").filter(Boolean);

    let out = "Proto";
    for (const p of parts) {
      if (p === "OA") out += "OA";
      else out += p.charAt(0) + p.slice(1).toLowerCase();
    }
    return out;
  }

  hasField(typeName: string, fieldName: string): boolean {
    const t = this.findType(typeName);
    return Boolean((t.fields as Record<string, unknown>)[fieldName]);
  }


  decodeMessage(typeName: string, bytes: Uint8Array): unknown {
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
  private findType(typeName: string): protobuf.Type {
    // 1) exact lookup
    try {
      return this.root.lookupType(typeName);
    } catch {
      // 2) exact alias lookup
      const alias = ProtoRegistry.TYPE_ALIASES[typeName];
      if (alias) {
        try {
          return this.root.lookupType(alias);
        } catch {
          // fallthrough
        }
      }

      // 3) suffix lookup for alias, then original
      if (alias) {
        try {
          return this.findTypeBySuffix(alias);
        } catch {
          // ignore
        }
      }

      return this.findTypeBySuffix(typeName);
    }
  }

  private findTypeBySuffix(suffix: string): protobuf.Type {
    const found = this.findAnySuffix(suffix, "Type");
    if (!(found instanceof protobuf.Type)) throw new Error(`Protobuf not found Type: ${suffix}`);
    return found;
  }

  private findEnumBySuffix(suffix: string): protobuf.Enum {
    const found = this.findAnySuffix(suffix, "Enum");
    if (!(found instanceof protobuf.Enum)) throw new Error(`Protobuf not found Enum: ${suffix}`);
    return found;
  }

  private findAnySuffix(suffix: string, kind: "Type" | "Enum"): unknown {
    const stack: unknown[] = [this.root as unknown];

    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;

      if (kind === "Type" && cur instanceof protobuf.Type && cur.fullName?.endsWith(suffix)) return cur;
      if (kind === "Enum" && cur instanceof protobuf.Enum && cur.fullName?.endsWith(suffix)) return cur;

      const nested = (cur as AnyNested).nested;
      if (nested && typeof nested === "object") {
        for (const v of Object.values(nested)) stack.push(v);
      }
    }

    throw new Error(`Protobuf not found: ${suffix}`);
  }

  private countAllTypes(): number {
    let count = 0;
    const stack: unknown[] = [this.root as unknown];

    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;

      if (cur instanceof protobuf.Type) count++;

      const nested = (cur as AnyNested).nested;
      if (nested && typeof nested === "object") {
        for (const v of Object.values(nested)) stack.push(v);
      }
    }

    return count;
  }

  private coerceEnums(type: protobuf.Type, obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  const out: any = { ...obj };

  for (const [fieldName, field] of Object.entries(type.fields)) {
    const v = out[fieldName];
    if (v == null) continue;

    const resolved: any = (field as any).resolvedType;
    const isEnum = resolved instanceof protobuf.Enum;
    if (!isEnum) continue;

    // single enum field
    if (typeof v === "string") {
      const mapped = resolved.values?.[v];
      if (mapped !== undefined) out[fieldName] = mapped;
    }

    // repeated enum field
    if (Array.isArray(v)) {
      out[fieldName] = v.map((x) => {
        if (typeof x !== "string") return x;
        const mapped = resolved.values?.[x];
        return mapped !== undefined ? mapped : x;
      });
    }
  }

  return out;
}

encodeMessage(typeName: string, obj: unknown): Uint8Array {
  const t = this.findType(typeName);
  const coerced = this.coerceEnums(t, obj as any);
  return t.encode(t.create(coerced as Record<string, unknown>)).finish();
}
}
