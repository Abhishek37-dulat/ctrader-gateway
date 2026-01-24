import path from "path";
import protobuf from "protobufjs";
import { Logger } from "../../logger.js";

type AnyNested = Record<string, unknown> & { nested?: Record<string, unknown> };

export class ProtoRegistry {
  public root!: protobuf.Root;

  constructor(private readonly logger: Logger) {}

  private payloadEnum!: protobuf.Enum;
  private protoMessageType!: protobuf.Type;

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
  ): Uint8Array {
    const obj = {
      payloadType: payloadTypeId,
      payload: payloadBytes,
    };
    return this.protoMessageType
      .encode(this.protoMessageType.create(obj))
      .finish();
  }

  decodeProtoMessage(bytes: Uint8Array): {
    payloadType: number;
    payload: Uint8Array;
    raw: unknown;
  } {
    const msg = this.protoMessageType.decode(bytes);
    const obj = this.protoMessageType.toObject(msg, {
      longs: String,
      enums: String,
      bytes: Buffer, // protobufjs uses Buffer in Node
      defaults: true,
    }) as { payloadType: number | string; payload: Buffer | Uint8Array };

    const payloadType = Number(obj.payloadType);
    const payload =
      obj.payload instanceof Uint8Array
        ? obj.payload
        : new Uint8Array(obj.payload);

    return { payloadType, payload, raw: obj };
  }

  payloadTypeName(id: number): string {
    for (const [k, v] of Object.entries(this.payloadEnum.values)) {
      if (v === id) return k;
    }
    throw new Error(`Unknown payloadType id=${id}`);
  }

  payloadTypeId(name: string): number {
    const v = this.payloadEnum.values[name];
    if (v === undefined) throw new Error(`PayloadType not found: ${name}`);
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

  encodeMessage(typeName: string, obj: unknown): Uint8Array {
    const t = this.findType(typeName);
    return t.encode(t.create(obj as Record<string, unknown>)).finish();
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
    try {
      return this.root.lookupType(typeName);
    } catch {
      return this.findTypeBySuffix(typeName);
    }
  }

  private findTypeBySuffix(suffix: string): protobuf.Type {
    const found = this.findAnySuffix(suffix, "Type");
    if (!(found instanceof protobuf.Type))
      throw new Error(`Protobuf not found Type: ${suffix}`);
    return found;
  }

  private findEnumBySuffix(suffix: string): protobuf.Enum {
    const found = this.findAnySuffix(suffix, "Enum");
    if (!(found instanceof protobuf.Enum))
      throw new Error(`Protobuf not found Enum: ${suffix}`);
    return found;
  }

  private findAnySuffix(suffix: string, kind: "Type" | "Enum"): unknown {
    const stack: unknown[] = [this.root as unknown];

    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;

      if (
        kind === "Type" &&
        cur instanceof protobuf.Type &&
        cur.fullName?.endsWith(suffix)
      )
        return cur;
      if (
        kind === "Enum" &&
        cur instanceof protobuf.Enum &&
        cur.fullName?.endsWith(suffix)
      )
        return cur;

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
}
