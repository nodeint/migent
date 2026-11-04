/** Keeps the last `limit` bytes written to it. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(readonly limit = 8192) {}

  append(chunk: Buffer | string): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.limit) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
  }

  toString(): string {
    const joined = Buffer.concat(this.chunks);
    return joined.subarray(Math.max(0, joined.length - this.limit)).toString("utf8").replace(/^�+/, "");
  }
}
