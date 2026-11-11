/** Keeps the last `limit` bytes written to it. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private seen = 0;

  constructor(public readonly limit = 8192) {}

  public append(chunk: Buffer | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (data.length === 0) return;
    this.seen += data.length;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.limit) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
  }

  /** Every byte ever appended, kept or not. */
  public get totalBytes(): number {
    return this.seen;
  }

  /** Bytes currently kept. */
  public get keptBytes(): number {
    return Math.min(this.size, this.limit);
  }

  public toString(): string {
    const joined = Buffer.concat(this.chunks);
    return joined.subarray(Math.max(0, joined.length - this.limit)).toString('utf8').replace(/^�+/, '');
  }
}
