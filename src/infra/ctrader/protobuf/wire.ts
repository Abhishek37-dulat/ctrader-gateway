export class Wire {
  static frame(payload: Uint8Array): Buffer {
    const len = payload.byteLength >>> 0;
    const buf = Buffer.allocUnsafe(4 + len);
    buf.writeUInt32BE(len, 0);
    Buffer.from(payload).copy(buf, 4);
    return buf;
  }

  static deframe(acc: Buffer): { frames: Buffer[]; rest: Buffer } {
    const frames: Buffer[] = [];
    let offset = 0;

    while (acc.length - offset >= 4) {
      const len = acc.readUInt32BE(offset);
      const total = 4 + len;
      if (len <= 0) break;
      if (acc.length - offset < total) break;

      frames.push(acc.subarray(offset + 4, offset + 4 + len));
      offset += total;
    }

    return { frames, rest: acc.subarray(offset) };
  }
}
