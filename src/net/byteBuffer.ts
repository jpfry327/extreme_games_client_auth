/**
 * Minimal binary read/write primitives for the snapshot codec (M2.13).
 *
 * Nothing here is game-specific — it's just the byte plumbing the snapshot codec
 * (`snapshotCodec.ts`) builds field encoders on top of. Two cursors over a
 * growable / fixed buffer:
 *
 *   - `ByteWriter` grows an internal `Uint8Array` as you append, then `bytes()`
 *     returns the exact-length view to hand to `ws.send`.
 *   - `ByteReader` walks a received buffer back, in the same field order.
 *
 * The writer and reader MUST stay mirror images — every `writeX` has a matching
 * `readX` consuming the identical number of bytes. The codec drives both from a
 * single field schema precisely so they can't drift.
 *
 * Encodings:
 *   - **varuint** — LEB128 unsigned, 7 bits/byte, little-endian. Small
 *     non-negative ints (ticks, counts, ammo, ids) cost 1 byte each up to 127.
 *     Every integer the sim produces is non-negative, so we never need zig-zag.
 *   - **f32** — IEEE-754 single, little-endian (4 bytes). Positions/velocities
 *     are quantized to f32 (~7 significant digits); at the map's far edge that's
 *     ~0.03px, invisible and well within the reconciliation smoother's budget.
 *   - **bool** — one byte, 0 or 1.
 *   - **string** — varuint length (UTF-8 byte count) followed by the bytes. A
 *     zero length is the empty string; the codec uses that as the `null` sentinel
 *     for optional ids (PlayerIds are never empty).
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  /** Ensure room for `n` more bytes, doubling the backing buffer as needed. */
  private ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeU8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeBool(v: boolean): void {
    this.writeU8(v ? 1 : 0);
  }

  /** LEB128 unsigned varint. `v` must be a non-negative, finite integer.
   *  A non-finite value (e.g. `Infinity`) would loop forever here
   *  (`Math.floor(Infinity / 128) === Infinity`), so reject it loudly rather than
   *  hang — fields with an unbounded sentinel must use their own encoding. */
  writeVaruint(v: number): void {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`writeVaruint expects a finite non-negative number, got ${v}`);
    }
    let n = Math.floor(v);
    this.ensure(8); // a 53-bit safe integer is at most 8 varint bytes
    while (n >= 0x80) {
      this.buf[this.pos++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.pos++] = n;
  }

  writeF32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  writeString(s: string): void {
    const bytes = textEncoder.encode(s);
    this.writeVaruint(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /** The written bytes as an exact-length view (no trailing capacity). */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  get length(): number {
    return this.pos;
  }
}

export class ByteReader {
  private view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readU8(): number {
    return this.buf[this.pos++];
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readVaruint(): number {
    let result = 0;
    let shift = 1; // multiplier (2^(7*k)), kept as a float so >32-bit-safe
    for (;;) {
      const byte = this.buf[this.pos++];
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }

  readF32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readString(): string {
    const len = this.readVaruint();
    const s = textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  /** True once every byte has been consumed — a cheap codec self-check. */
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}
