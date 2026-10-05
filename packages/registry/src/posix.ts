import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface KoffiLib {
  func(definition: string): (...args: never[]) => unknown;
}

interface FsExtConstants {
  F_GETFD: number;
  F_SETFD: number;
  F_GETLK: number;
  F_SETLK: number;
  F_SETLKW: number;
  F_RDLCK: number;
  F_WRLCK: number;
  F_UNLCK: number;
  FD_CLOEXEC: number;
}

interface FsExt {
  fcntl(
    fd: number,
    cmd: number | string,
    arg: number,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  fcntlSync(fd: number, cmd: number | string, arg?: number): number;
  constants: FsExtConstants;
}

const koffi = require("koffi") as {
  load(name: string): KoffiLib;
  struct(name: string, definition: Record<string, string>): unknown;
};

export const fsExt = require("fs-ext") as FsExt;

/** POSIX F_GETFL / F_SETFL. Not flock commands; fs-ext fcntlSync is safe for these. */
export const F_GETFL = 3;
export const F_SETFL = 4;

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

export function fcntlLock(fd: number, cmd: number, lockType: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.fcntl(fd, cmd, lockType, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function setNonBlocking(fd: number): void {
  const flags = fsExt.fcntlSync(fd, F_GETFL, 0);
  fsExt.fcntlSync(fd, F_SETFL, flags | fsConstants.O_NONBLOCK);
}
