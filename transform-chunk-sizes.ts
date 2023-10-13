/**
 * Copy bytes from the `src` array to the `dst` array. Returns the number of
 * bytes copied.
 *
 * From https://github.com/denoland/deno_std/blob/0.204.0/bytes/copy.ts
 * Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.// [0, 1, 1, 1]
 * ```
 */
export function copy(src: Uint8Array, dst: Uint8Array, off = 0): number {
  off = Math.max(0, Math.min(off, dst.byteLength));
  const dstBytesAvailable = dst.byteLength - off;
  if (src.byteLength > dstBytesAvailable) {
    src = src.subarray(0, dstBytesAvailable);
  }
  dst.set(src, off);
  return src.byteLength;
}

const MAX_SIZE = 2 ** 32 - 2;

/**
 * A variable-sized buffer of bytes with `read()` and `write()` methods.
 *
 * From https://github.com/denoland/deno_std/blob/0.204.0/io/buffer.ts
 * Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
 *
 * Based on [Go Buffer](https://golang.org/pkg/bytes/#Buffer).
 */
export class Buffer {
  #buf: Uint8Array; // contents are the bytes buf[off : len(buf)]
  #off = 0; // read at buf[off], write at buf[buf.byteLength]

  constructor() {
    this.#buf = new Uint8Array(0);
  }

  /** Returns a slice holding the unread portion of the buffer.
   *
   * The slice is valid for use only until the next buffer modification (that
   * is, only until the next call to a method like `read()`, `write()`,
   * `reset()`, or `truncate()`). If `options.copy` is false the slice aliases the buffer content at
   * least until the next buffer modification, so immediate changes to the
   * slice will affect the result of future reads.
   * @param [options={ copy: true }]
   */
  bytes(options = { copy: true }): Uint8Array {
    if (options.copy === false) return this.#buf.subarray(this.#off);
    return this.#buf.slice(this.#off);
  }

  /** Returns whether the unread portion of the buffer is empty. */
  empty(): boolean {
    return this.#buf.byteLength <= this.#off;
  }

  /** A read only number of bytes of the unread portion of the buffer. */
  get length(): number {
    return this.#buf.byteLength - this.#off;
  }

  /** The read only capacity of the buffer's underlying byte slice, that is,
   * the total space allocated for the buffer's data. */
  get capacity(): number {
    return this.#buf.buffer.byteLength;
  }

  reset() {
    this.#reslice(0);
    this.#off = 0;
  }

  #tryGrowByReslice(n: number) {
    const l = this.#buf.byteLength;
    if (n <= this.capacity - l) {
      this.#reslice(l + n);
      return l;
    }
    return -1;
  }

  #reslice(len: number) {
    if (len > this.#buf.buffer.byteLength) throw new Error("Invalid usage");
    this.#buf = new Uint8Array(this.#buf.buffer, 0, len);
  }

  /** Reads the next `p.length` bytes from the buffer or until the buffer is
   * drained. Returns the number of bytes read. If the buffer has no data to
   * return, the return is EOF (`null`). */
  read(p: Uint8Array): number | null {
    if (this.empty()) {
      // Buffer is empty, reset to recover space.
      this.reset();
      if (p.byteLength === 0) {
        // this edge case is tested in 'bufferReadEmptyAtEOF' test
        return 0;
      }
      return null;
    }
    const nread = copy(this.#buf.subarray(this.#off), p);
    this.#off += nread;
    return nread;
  }

  write(p: Uint8Array): number {
    const m = this.#grow(p.byteLength);
    return copy(p, this.#buf, m);
  }

  #grow(n: number) {
    const m = this.length;
    // If buffer is empty, reset to recover space.
    if (m === 0 && this.#off !== 0) {
      this.reset();
    }
    // Fast: Try to grow by means of a reslice.
    const i = this.#tryGrowByReslice(n);
    if (i >= 0) {
      return i;
    }
    const c = this.capacity;
    if (n <= Math.floor(c / 2) - m) {
      // We can slide things down instead of allocating a new
      // ArrayBuffer. We only need m+n <= c to slide, but
      // we instead let capacity get twice as large so we
      // don't spend all our time copying.
      copy(this.#buf.subarray(this.#off), this.#buf);
    } else if (c + n > MAX_SIZE) {
      throw new Error("The buffer cannot be grown beyond the maximum size.");
    } else {
      // Not enough space anywhere, we need to allocate.
      const buf = new Uint8Array(Math.min(2 * c + n, MAX_SIZE));
      copy(this.#buf.subarray(this.#off), buf);
      this.#buf = buf;
    }
    // Restore this.#off and len(this.#buf).
    this.#off = 0;
    this.#reslice(Math.min(m + n, MAX_SIZE));
    return m;
  }

  /** Grows the buffer's capacity, if necessary, to guarantee space for
   * another `n` bytes. After `.grow(n)`, at least `n` bytes can be written to
   * the buffer without another allocation. If `n` is negative, `.grow()` will
   * throw. If the buffer can't grow it will throw an error.
   *
   * Based on Go Lang's
   * [Buffer.Grow](https://golang.org/pkg/bytes/#Buffer.Grow). */
  grow(n: number) {
    if (n < 0) {
      throw Error("Buffer.grow: negative count");
    }
    const m = this.#grow(n);
    this.#reslice(m);
  }
}

/**
 * This stream transform will buffer the data it receives until it has enough to form
 * a chunk of the specified size, then pass on the data in chunks of the specified size.
 */
export class TransformChunkSizes extends TransformStream<Uint8Array, Uint8Array> {
  constructor(outChunkSize: number) {
    // This large buffer holds all the incoming data we receive until we reach at least outChunkSize, which we then pass on.
    const buffer = new Buffer();
    buffer.grow(outChunkSize);

    super({
      start() {}, // required
      transform(chunk, controller) {
        buffer.write(chunk);

        while (buffer.length >= outChunkSize) {
          const outChunk = new Uint8Array(outChunkSize);
          const readFromBuffer = buffer.read(outChunk);
          if (readFromBuffer !== outChunkSize) {
            throw new Error(
              `Unexpectedly read ${readFromBuffer} bytes from transform buffer when trying to read ${outChunkSize} bytes.`,
            );
          }
          // Now "outChunk" holds the next chunk of data - pass it on to the output:
          controller.enqueue(outChunk);
        }
      },
      flush(controller) {
        if (buffer.length) {
          // The buffer still contains some data, send it now even though it's smaller than the desired chunk size.
          controller.enqueue(buffer.bytes());
        }
      },
    });
  }
}
