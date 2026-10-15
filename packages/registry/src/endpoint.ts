import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// The running service listens on a local endpoint for its whole life. Only one process can
// listen at a time, and the OS frees it when the process dies, so the endpoint is the service's
// lifetime lock. A client that connects reads one hello line naming the instance and its pid,
// and may then send `stop <token>` to ask that instance to shut down.

const POSIX_SOCKET_PATH_MAX = 100;
const HELLO_LIMIT = 4096;

export interface EndpointHello {
  instance_id: string;
  pid: number;
}

export type EndpointStatus =
  | { state: "alive"; hello: EndpointHello }
  | { state: "gone" }
  | { state: "unknown" };

export function serviceEndpointPath(home: string): string {
  const resolved = path.resolve(home);
  const name = `migent-registry-${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const local = path.join(resolved, "service.sock");
  if (Buffer.byteLength(local) <= POSIX_SOCKET_PATH_MAX) return local;
  return path.join(tmpdir(), `${name}.sock`);
}

function parseHello(line: string): EndpointHello | null {
  try {
    const payload = JSON.parse(line) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const { instance_id: instanceId, pid } = payload as Record<string, unknown>;
    if (typeof instanceId !== "string" || !instanceId) return null;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return { instance_id: instanceId, pid };
  } catch {
    return null;
  }
}

/** Connect, read the hello line, then optionally send the command chosen for that hello and read its reply. */
function exchange(
  endpoint: string,
  timeoutSec: number,
  commandFor: ((hello: EndpointHello) => string | null) | null,
): Promise<{ status: EndpointStatus; reply: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let hello: EndpointHello | null = null;
    const socket: Socket = connect(endpoint);
    const finish = (status: EndpointStatus, reply: string | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, reply });
    };
    const timer = setTimeout(() => finish(hello ? { state: "alive", hello } : { state: "unknown" }), timeoutSec * 1000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > HELLO_LIMIT) return finish({ state: "unknown" });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (hello === null) {
          hello = parseHello(line);
          if (hello === null) return finish({ state: "unknown" });
          const command = commandFor ? commandFor(hello) : null;
          if (command === null) return finish({ state: "alive", hello });
          socket.write(`${command}\n`);
        } else {
          return finish({ state: "alive", hello }, line);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (hello) return finish({ state: "alive", hello });
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? { state: "gone" } : { state: "unknown" });
    });
    socket.on("close", () => finish(hello ? { state: "alive", hello } : { state: "unknown" }));
  });
}

export async function queryEndpoint(home: string, timeoutSec = 1): Promise<EndpointStatus> {
  return (await exchange(serviceEndpointPath(home), timeoutSec, null)).status;
}

/** Ask the instance to stop. True when it accepted; it shuts down right after replying. */
export async function requestStop(home: string, instanceId: string, token: string, timeoutSec = 1): Promise<boolean> {
  const { status, reply } = await exchange(serviceEndpointPath(home), timeoutSec, (hello) =>
    hello.instance_id === instanceId ? `stop ${token}` : null,
  );
  return status.state === "alive" && status.hello.instance_id === instanceId && reply === "ok";
}

function removeSocketFile(endpoint: string): void {
  if (process.platform === "win32") return;
  try {
    unlinkSync(endpoint);
  } catch {
    // absent
  }
}

function listenOn(server: Server, endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

export class ServiceEndpointServer {
  private readonly server: Server;
  readonly endpoint: string;

  private constructor(server: Server, endpoint: string) {
    this.server = server;
    this.endpoint = endpoint;
  }

  /**
   * Take the endpoint for this process, or return null while another live process holds it.
   * Callers hold start.lock, which makes replacing a stale POSIX socket file safe.
   */
  static async listen(
    home: string,
    hello: EndpointHello,
    token: string,
    onStop: () => void,
  ): Promise<ServiceEndpointServer | null> {
    const endpoint = serviceEndpointPath(home);
    const helloLine = `${JSON.stringify(hello)}\n`;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > HELLO_LIMIT) return socket.destroy();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        if (buffer.slice(0, newline) === `stop ${token}`) {
          socket.end("ok\n");
          onStop();
        } else {
          socket.end("denied\n");
        }
      });
      socket.write(helloLine);
    });
    if (process.platform !== "win32") {
      const current = await exchange(endpoint, 1, null);
      if (current.status.state !== "gone") return null;
      removeSocketFile(endpoint);
    }
    if (!(await listenOn(server, endpoint))) return null;
    return new ServiceEndpointServer(server, endpoint);
  }

  close(): void {
    this.server.close();
    removeSocketFile(this.endpoint);
  }
}
