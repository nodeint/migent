import { createServer, type AddressInfo, type Socket } from "node:net";
import { Call, Router, buildRouter, type WorkspaceRecords } from "./routes.js";
import type { RegistryStore } from "./store.js";
import { monotonic } from "./time.js";

export const DEFAULT_PORT = 47321;
export const MAX_BODY_BYTES = 65536;

const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
};

export class RequestTimeout extends Error {
  constructor() {
    super("request timeout");
    this.name = "RequestTimeout";
  }
}

class ShortBody extends Error {}

class SocketFeed {
  private readonly chunks: Buffer[] = [];
  private waiter: ((chunk: Buffer | null) => void) | null = null;
  private ended = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      const data = Buffer.from(chunk);
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        this.clearTimer();
        resolve(data);
      } else {
        this.chunks.push(data);
      }
    });
    const finish = (): void => {
      this.ended = true;
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        this.clearTimer();
        resolve(null);
      }
    };
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  readChunk(deadline: number): Promise<Buffer | null> {
    const queued = this.chunks.shift();
    if (queued) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(null);
    const remaining = deadline - monotonic();
    if (remaining <= 0) return Promise.reject(new RequestTimeout());
    return new Promise((resolve, reject) => {
      this.timer = setTimeout(() => {
        this.waiter = null;
        this.timer = null;
        reject(new RequestTimeout());
      }, remaining * 1000);
      this.waiter = (chunk) => resolve(chunk);
    });
  }
}

class DeadlineReader {
  private buffer = Buffer.alloc(0);
  readonly clock: { deadline: number };
  private readonly feed: SocketFeed;

  constructor(feed: SocketFeed, clock: { deadline: number }) {
    this.feed = feed;
    this.clock = clock;
  }

  setDeadline(deadline: number): void {
    this.clock.deadline = deadline;
  }

  async read(size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0);
    if (size < 0) {
      while (await this.fillOne()) {
        // drain
      }
      const data = this.buffer;
      this.buffer = Buffer.alloc(0);
      return data;
    }
    while (this.buffer.length < size) {
      if (!(await this.fillOne())) break;
    }
    const data = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return Buffer.from(data);
  }

  async readLine(limit: number): Promise<Buffer> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline !== -1 && newline + 1 <= limit) {
        const data = this.buffer.subarray(0, newline + 1);
        this.buffer = this.buffer.subarray(newline + 1);
        return Buffer.from(data);
      }
      if (this.buffer.length >= limit) {
        const data = this.buffer.subarray(0, limit);
        this.buffer = this.buffer.subarray(limit);
        return Buffer.from(data);
      }
      if (!(await this.fillOne())) {
        const data = this.buffer;
        this.buffer = Buffer.alloc(0);
        return Buffer.from(data);
      }
    }
  }

  private async fillOne(): Promise<boolean> {
    const remaining = this.clock.deadline - monotonic();
    if (remaining <= 0) throw new RequestTimeout();
    const data = await this.feed.readChunk(this.clock.deadline);
    if (!data || data.length === 0) return false;
    this.buffer = Buffer.concat([this.buffer, data]);
    return true;
  }
}

function errorBody(code: string, message: string): Record<string, string> {
  return { error: code, message };
}

function contentLength(values: string[], cap: number): ["ok", number] | ["invalid", null] | ["too_large", null] {
  if (values.length !== 1) return ["invalid", null];
  const text = values[0] ?? "";
  if (text.trim() !== text || !/^\d+$/.test(text)) return ["invalid", null];
  const significant = text.replace(/^0+/, "");
  if (significant === "") return ["ok", 0];
  const capText = String(cap);
  if (significant.length > capText.length || (significant.length === capText.length && significant > capText)) {
    return ["too_large", null];
  }
  return ["ok", Number(significant)];
}

async function writeAll(socket: Socket, payload: Buffer, deadlineSec: number): Promise<void> {
  const deadline = monotonic() + deadlineSec;
  await new Promise<void>((resolve, reject) => {
    const remaining = deadline - monotonic();
    if (remaining <= 0) {
      reject(new RequestTimeout());
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RequestTimeout());
    }, remaining * 1000);
    socket.write(payload, (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

export class RegistryHTTPServer {
  static daemonThreads = true;
  inFlight = 0;
  timeout = 0.2;
  readonly store: RegistryStore;
  token: string;
  instanceId: string;
  readonly readDeadlineSec: number;
  readonly writeDeadlineSec: number;
  readonly maxBodyBytes: number;
  readonly router: Router;
  port = 0;
  private readonly tcp = createServer();
  private readonly queued: Socket[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly feeds = new WeakMap<Socket, SocketFeed>();
  private acceptWaiter: ((socket: Socket | null) => void) | null = null;
  private closed = false;

  private constructor(
    store: RegistryStore,
    token: string,
    instanceId: string,
    readDeadlineSec: number,
    writeDeadlineSec: number,
    maxBodyBytes: number,
  ) {
    this.store = store;
    this.token = token;
    this.instanceId = instanceId;
    this.readDeadlineSec = readDeadlineSec;
    this.writeDeadlineSec = writeDeadlineSec;
    this.maxBodyBytes = maxBodyBytes;
    this.router = buildRouter();
    this.tcp.on("connection", (socket) => {
      socket.on("error", () => undefined);
      const feed = new SocketFeed(socket);
      this.feeds.set(socket, feed);
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      if (this.acceptWaiter) {
        const waiter = this.acceptWaiter;
        this.acceptWaiter = null;
        waiter(socket);
      } else {
        this.queued.push(socket);
      }
    });
  }

  static async open(
    store: RegistryStore,
    token: string,
    instanceId: string,
    host = "127.0.0.1",
    port = DEFAULT_PORT,
    options: {
      readDeadlineSec?: number;
      writeDeadlineSec?: number;
      maxBodyBytes?: number;
    } = {},
  ): Promise<RegistryHTTPServer> {
    if (host !== "127.0.0.1") throw new Error("The registry service binds 127.0.0.1 only.");
    const server = new RegistryHTTPServer(
      store,
      token,
      instanceId,
      options.readDeadlineSec ?? 5,
      options.writeDeadlineSec ?? 5,
      options.maxBodyBytes ?? MAX_BODY_BYTES,
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.tcp.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.tcp.off("error", onError);
        resolve();
      };
      server.tcp.once("error", onError);
      server.tcp.listen(port, host, onListening);
    });
    const address = server.tcp.address() as AddressInfo;
    if (!address || address.address !== "127.0.0.1") {
      server.close();
      throw new Error("The registry service binds 127.0.0.1 only.");
    }
    server.port = address.port;
    return server;
  }

  async getRequest(): Promise<Socket | null> {
    const queued = this.queued.shift();
    if (queued) return queued;
    if (this.closed) return null;
    const timeout = this.timeout;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (socket: Socket | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.acceptWaiter === finish) this.acceptWaiter = null;
        resolve(socket);
      };
      const timer = setTimeout(() => finish(null), Math.max(0, timeout) * 1000);
      this.acceptWaiter = finish;
    });
  }

  async handleRequest(): Promise<void> {
    const socket = await this.getRequest();
    if (!socket) return;
    void this.processSocket(socket);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.acceptWaiter) {
      const waiter = this.acceptWaiter;
      this.acceptWaiter = null;
      waiter(null);
    }
    for (const socket of this.sockets) socket.destroy();
    this.tcp.close();
  }

  private async processSocket(socket: Socket): Promise<void> {
    this.inFlight += 1;
    const feed = this.feeds.get(socket);
    if (!feed) {
      this.inFlight -= 1;
      return;
    }
    const reader = new DeadlineReader(feed, { deadline: monotonic() + this.readDeadlineSec });
    const state = { responseStarted: false };
    try {
      let close = false;
      do {
        close = await this.handleOne(socket, reader, state);
      } while (!close && !socket.destroyed);
    } catch (error) {
      if (error instanceof RequestTimeout) {
        await this.writeTimeout(socket, state);
      }
    } finally {
      this.inFlight -= 1;
      if (!socket.destroyed) socket.destroy();
    }
  }

  private async handleOne(socket: Socket, reader: DeadlineReader, state: { responseStarted: boolean }): Promise<boolean> {
    state.responseStarted = false;
    reader.setDeadline(monotonic() + this.readDeadlineSec);
    const line = await reader.readLine(65537);
    if (line.length === 0) return true;
    if (line.length > 65536) {
      await this.sendJson(socket, 400, errorBody("invalid_request", "Request line is too long."), true, state);
      return true;
    }
    const parsed = parseRequestLine(line);
    if (!parsed) {
      await this.sendJson(socket, 400, errorBody("invalid_request", "Invalid request."), true, state);
      return true;
    }
    const headerBytes = await readHeaders(reader);
    if (headerBytes === null) {
      await this.sendJson(socket, 400, errorBody("invalid_request", "Invalid request."), true, state);
      return true;
    }
    const headers = parseHeaders(headerBytes);
    const closeRequested = connectionClose(parsed.version, headers);
    const path = decodePath(parsed.target);
    let body: Buffer | null = null;
    if (this.router.shouldReadBody(parsed.method, path)) {
      const limited = await this.readLimitedBody(socket, reader, parsed.method, headers, state);
      if (limited === null) return true;
      body = limited;
    }
    const call = new Call({
      method: parsed.method,
      path,
      store: this.store as WorkspaceRecords,
      token: this.token,
      instanceId: this.instanceId,
      authorization: headerValue(headers, "authorization"),
      body,
      beforeStore: () => undefined,
    });
    const response = await this.router.hono.request(new Request(`http://127.0.0.1${path}`, { method: parsed.method }), undefined, {
      call,
    });
    const payload = Buffer.from(await response.arrayBuffer());
    await this.sendRaw(socket, response.status, payload, closeRequested, state);
    return closeRequested;
  }

  private async readLimitedBody(
    socket: Socket,
    reader: DeadlineReader,
    method: string,
    headers: Map<string, string[]>,
    state: { responseStarted: boolean },
  ): Promise<Buffer | null> {
    if (method !== "POST") return Buffer.alloc(0);
    if (headers.has("transfer-encoding")) {
      await this.sendJson(socket, 400, errorBody("invalid_request", "Transfer-Encoding is not accepted."), false, state);
      return null;
    }
    const lengths = headers.get("content-length") ?? [];
    const [kind, length] = contentLength(lengths, this.maxBodyBytes);
    if (kind === "too_large") {
      await this.sendJson(socket, 413, errorBody("payload_too_large", "Content-Length exceeds 65536 bytes."), true, state);
      return null;
    }
    if (kind !== "ok" || length === null) {
      await this.sendJson(socket, 400, errorBody("invalid_request", "Content-Length is missing or invalid."), false, state);
      return null;
    }
    try {
      const body = await reader.read(length);
      if (body.length !== length) {
        await this.sendJson(socket, 400, errorBody("invalid_request", "Request body was truncated."), false, state);
        return null;
      }
      return body;
    } catch (error) {
      if (error instanceof RequestTimeout) throw error;
      await this.sendJson(socket, 400, errorBody("invalid_request", "Request body was truncated."), false, state);
      return null;
    }
  }

  private async writeTimeout(socket: Socket, state: { responseStarted: boolean }): Promise<void> {
    if (state.responseStarted || socket.destroyed) return;
    try {
      await this.sendJson(
        socket,
        408,
        errorBody("request_timeout", "The request was not fully read before the deadline."),
        true,
        state,
      );
    } catch {
      socket.destroy();
    }
  }

  private async sendJson(
    socket: Socket,
    status: number,
    payload: Record<string, unknown>,
    close: boolean,
    state: { responseStarted: boolean },
  ): Promise<void> {
    await this.sendRaw(socket, status, Buffer.from(JSON.stringify(payload)), close, state);
  }

  private async sendRaw(
    socket: Socket,
    status: number,
    payload: Buffer,
    close: boolean,
    state: { responseStarted: boolean },
  ): Promise<void> {
    if (state.responseStarted) return;
    state.responseStarted = true;
    const reason = REASONS[status] ?? "Error";
    const headers = [
      `HTTP/1.1 ${status} ${reason}`,
      "Content-Type: application/json",
      `Content-Length: ${payload.length}`,
      "Cache-Control: no-store",
    ];
    if (close) headers.push("Connection: close");
    const raw = Buffer.concat([Buffer.from(`${headers.join("\r\n")}\r\n\r\n`), payload]);
    try {
      await writeAll(socket, raw, this.writeDeadlineSec);
    } catch {
      socket.destroy();
    }
  }
}

function parseRequestLine(line: Buffer): { method: string; target: string; version: string } | null {
  const text = line.toString("utf8").replace(/\r?\n$/, "");
  const parts = text.split(" ");
  if (parts.length !== 3) return null;
  const [method, target, version] = parts;
  if (!method || !target || !version?.startsWith("HTTP/")) return null;
  return { method, target, version };
}

async function readHeaders(reader: DeadlineReader): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < 65536) {
    const line = await reader.readLine(65537);
    if (line.length === 0) return null;
    chunks.push(line);
    total += line.length;
    if (line.equals(Buffer.from("\r\n")) || line.equals(Buffer.from("\n"))) return Buffer.concat(chunks);
  }
  return null;
}

function parseHeaders(raw: Buffer): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const text = raw.toString("utf8");
  for (const line of text.split("\r\n")) {
    if (line === "") continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).replace(/^[ \t]+/, "");
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
}

function headerValue(headers: Map<string, string[]>, name: string): string | null {
  const values = headers.get(name);
  if (!values || values.length === 0) return null;
  return values[0] ?? null;
}

function connectionClose(version: string, headers: Map<string, string[]>): boolean {
  const connection = (headers.get("connection") ?? []).join(",");
  const tokens = connection.split(",").map((item) => item.trim().toLowerCase());
  if (tokens.includes("close")) return true;
  if (version === "HTTP/1.0") return !tokens.includes("keep-alive");
  return false;
}

function decodePath(target: string): string {
  const withoutQuery = target.split("?")[0] ?? target;
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

void ShortBody;
