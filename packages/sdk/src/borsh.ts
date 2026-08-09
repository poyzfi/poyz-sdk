/**
 * Minimal Borsh reader and writer, sized to exactly the layouts this program
 * uses.
 *
 * Anchor serialises account state and instruction arguments with Borsh: fields
 * in declaration order, integers little-endian, no padding, no framing. Pulling
 * in a general Borsh runtime for seven scalar types would add a dependency to a
 * package that a browser has to download, so the subset lives here.
 *
 * Unsigned 64 and 128 bit integers are read as `bigint`. Routing a u64 through
 * `number` loses precision above 2^53, and lamport balances reach that.
 */

const DECODER_LIMIT_U64 = 8;
const DECODER_LIMIT_U128 = 16;

/** Sequential little-endian reader over an account data buffer. */
export class BorshReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private cursor: number;

  constructor(data: Uint8Array, offset = 0) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.cursor = offset;
  }

  /** Bytes not yet consumed. */
  get remaining(): number {
    return this.bytes.byteLength - this.cursor;
  }

  private take(length: number): number {
    if (this.cursor + length > this.bytes.byteLength) {
      throw new RangeError(
        `borsh: read of ${length} bytes at offset ${this.cursor} exceeds the ${this.bytes.byteLength} byte buffer`,
      );
    }
    const start = this.cursor;
    this.cursor += length;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(DECODER_LIMIT_U64), true);
  }

  i64(): bigint {
    return this.view.getBigInt64(this.take(DECODER_LIMIT_U64), true);
  }

  u128(): bigint {
    const start = this.take(DECODER_LIMIT_U128);
    const low = this.view.getBigUint64(start, true);
    const high = this.view.getBigUint64(start + 8, true);
    return (high << 64n) | low;
  }

  /** A fixed-width byte array, copied out of the source buffer. */
  fixedBytes(length: number): Uint8Array {
    const start = this.take(length);
    return this.bytes.slice(start, start + length);
  }

  /** A 32 byte public key, returned raw. Convert with `PublicKey`. */
  publicKeyBytes(): Uint8Array {
    return this.fixedBytes(32);
  }

  /** Skip forward without decoding, for reserved padding. */
  skip(length: number): void {
    this.take(length);
  }
}

/** Sequential little-endian writer for instruction argument data. */
export class BorshWriter {
  private chunks: number[] = [];

  u8(value: number): this {
    assertUint(value, 0xff, "u8");
    this.chunks.push(value & 0xff);
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    assertUint(value, 0xffff, "u16");
    this.chunks.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    assertUint(value, 0xffff_ffff, "u32");
    const buffer = new DataView(new ArrayBuffer(4));
    buffer.setUint32(0, value, true);
    return this.rawView(buffer);
  }

  i32(value: number): this {
    if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
      throw new RangeError(`borsh: ${value} does not fit in an i32`);
    }
    const buffer = new DataView(new ArrayBuffer(4));
    buffer.setInt32(0, value, true);
    return this.rawView(buffer);
  }

  u64(value: bigint): this {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(`borsh: ${value} does not fit in a u64`);
    }
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setBigUint64(0, value, true);
    return this.rawView(buffer);
  }

  i64(value: bigint): this {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setBigInt64(0, value, true);
    return this.rawView(buffer);
  }

  /** Append raw bytes, for discriminators and fixed-width arrays. */
  bytes(value: Uint8Array | readonly number[]): this {
    for (const byte of value) {
      this.chunks.push(byte & 0xff);
    }
    return this;
  }

  /** Append a fixed-width array, checking the width first. */
  fixedBytes(value: Uint8Array, length: number): this {
    if (value.byteLength !== length) {
      throw new RangeError(`borsh: expected ${length} bytes, received ${value.byteLength}`);
    }
    return this.bytes(value);
  }

  private rawView(view: DataView): this {
    for (let i = 0; i < view.byteLength; i += 1) {
      this.chunks.push(view.getUint8(i));
    }
    return this;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function assertUint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`borsh: ${value} does not fit in a ${label}`);
  }
}

/** Little-endian u64 encoding, used for PDA seeds derived from a counter. */
export function u64Seed(value: bigint): Uint8Array {
  return new BorshWriter().u64(value).toUint8Array();
}

/** Lowercase hex, for proof hashes and instruction data in plans. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Parse lowercase or uppercase hex into bytes.
 *
 * @throws RangeError when the input is not an even-length hex string.
 */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new RangeError("expected an even-length hexadecimal string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** True when the first bytes of `data` equal `discriminator`. */
export function hasDiscriminator(data: Uint8Array, discriminator: readonly number[]): boolean {
  if (data.byteLength < discriminator.length) {
    return false;
  }
  for (let i = 0; i < discriminator.length; i += 1) {
    if (data[i] !== discriminator[i]) {
      return false;
    }
  }
  return true;
}
