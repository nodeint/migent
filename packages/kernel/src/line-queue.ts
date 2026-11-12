import type { Readable } from 'node:stream';

/** Newline-split stdout lines, consumed one at a time with a timeout. */
export interface LineQueue {
  get(timeoutMs: number): Promise<string | null | 'timeout' | 'cancel'>;
  /** Bytes received on the stream so far, before any line normalization. */
  bytes(): number;
}

/** Queues a stream's lines; `onCancel` registers a cancellation waiter and returns its unsubscribe. */
export function createLineQueue(stream: Readable | null, onCancel: (waiter: () => void) => () => void): LineQueue {
  let received = 0;
  const lines: (string | null)[] = [];
  let waiter: ((value: string | null | 'timeout' | 'cancel') => void) | null = null;
  if (stream) {
    stream.setEncoding('utf8');
    let buffer = '';
    const push = (line: string | null) => {
      if (waiter) {
        const pending = waiter;
        waiter = null;
        pending(line);
      } else {
        lines.push(line);
      }
    };
    stream.on('data', (chunk: string) => {
      received += Buffer.byteLength(chunk);
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        push(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    const finish = () => {
      if (buffer.length > 0) {
        push(buffer);
        buffer = '';
      }
      push(null);
    };
    stream.on('end', finish);
    stream.on('error', () => {
      finish();
    });
  } else {
    lines.push(null);
  }
  return {
    bytes: () => received,
    get(timeoutMs: number) {
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          unsubscribe();
          resolve('timeout');
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          waiter = null;
          unsubscribe();
          resolve('cancel');
        };
        const unsubscribe = onCancel(wake);
        waiter = (value) => {
          clearTimeout(timer);
          unsubscribe();
          resolve(value);
        };
      });
    },
  };
}
