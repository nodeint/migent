import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { POSIX, fcntlInt } from "@nodeint/migent-kernel";

const require = createRequire(import.meta.url);

export { POSIX, fcntlInt, fcntlLock } from "@nodeint/migent-kernel";

interface KoffiLib {
  func(definition: string): (...args: never[]) => unknown;
}

const koffi = require("koffi") as {
  load(name: string): KoffiLib;
  struct(name: string, definition: Record<string, string>): unknown;
};

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const WNOHANG = 1;

let socketpairFn: ((domain: number, type: number, protocol: number, out: { a?: number; b?: number }) => number) | null =
  null;
let getpgidFn: ((pid: number) => number) | null = null;
let waitpidFn: ((pid: number, status: number[], options: number) => number) | null = null;

function libc(): KoffiLib {
  const name = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  return koffi.load(name);
}

function socketpairCall(): (domain: number, type: number, protocol: number, out: { a?: number; b?: number }) => number {
  if (socketpairFn !== null) return socketpairFn;
  koffi.struct("RegistrySocketPair", { a: "int", b: "int" });
  socketpairFn = libc().func(
    "int socketpair(int domain, int type, int protocol, _Out_ RegistrySocketPair *sv)",
  ) as unknown as (domain: number, type: number, protocol: number, out: { a?: number; b?: number }) => number;
  return socketpairFn;
}

export function socketpair(): [number, number] {
  const out: { a?: number; b?: number } = {};
  const rc = socketpairCall()(AF_UNIX, SOCK_STREAM, 0, out);
  if (rc !== 0 || out.a === undefined || out.b === undefined) {
    const error = new Error("socketpair failed") as NodeJS.ErrnoException;
    error.code = "EIO";
    throw error;
  }
  // libc sockets are inheritable. On Linux libuv forks without closing stray fds, so
  // a spawned child would hold both ends and never see EOF when its parent dies.
  for (const fd of [out.a, out.b]) {
    fcntlInt(fd, POSIX.F_SETFD, fcntlInt(fd, POSIX.F_GETFD) | POSIX.FD_CLOEXEC);
  }
  return [out.a, out.b];
}

export function posixGetpgid(pid: number): number | null {
  try {
    if (getpgidFn === null) {
      getpgidFn = libc().func("int getpgid(int pid)") as unknown as (pid: number) => number;
    }
    const pgid = getpgidFn(pid);
    if (pgid < 0) return null;
    return pgid;
  } catch {
    return null;
  }
}

export function reapChild(pid: number): boolean {
  try {
    if (waitpidFn === null) {
      waitpidFn = libc().func("int waitpid(int pid, _Out_ int *status, int options)") as unknown as (
        pid: number,
        status: number[],
        options: number,
      ) => number;
    }
    const status = [0];
    const waited = waitpidFn(pid, status, WNOHANG);
    return waited === pid;
  } catch {
    return false;
  }
}

export function setNonBlocking(fd: number): void {
  const flags = fcntlInt(fd, POSIX.F_GETFL);
  fcntlInt(fd, POSIX.F_SETFL, flags | fsConstants.O_NONBLOCK);
}
