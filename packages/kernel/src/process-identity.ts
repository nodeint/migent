import { createRequire } from "node:module";
import { closeSync, constants as fsConstants, openSync, readFileSync } from "node:fs";
import { POSIX, fcntlFlockStruct, packFlock, readI32, readI64, unpackFlock } from "./posix.js";

// POSIX-only process identity used by the registry service lock. The provider
// process wrapper no longer depends on it.

const require = createRequire(import.meta.url);

const PROC_PIDTBSDINFO = 3;
const DARWIN_PROC_BSDINFO_SIZE = 136;
const DARWIN_START_TIME_OFFSET = 120;
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const DARWIN_KINFO_BUF = 4096;

interface KoffiLib {
  func(definition: string): (...args: never[]) => unknown;
}

interface TimevalOut {
  tv_sec?: number | bigint;
  tv_usec?: number | bigint;
}

let systemLib: KoffiLib | null = null;
let getpgidFn: ((pid: number) => number) | null = null;
let procPidinfoFn:
  | ((pid: number, flavor: number, arg: number, buffer: Buffer, size: number) => number)
  | null = null;
let sysctlByNameFn:
  | ((
      name: string,
      out: TimevalOut,
      size: Array<number | bigint>,
      newp: null,
      newlen: number,
    ) => number)
  | null = null;

function libc(): KoffiLib {
  if (systemLib !== null) return systemLib;
  const koffi = require("koffi") as {
    load(name: string): KoffiLib;
    struct(name: string, def: Record<string, string>): unknown;
  };
  const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const loaded = koffi.load(library);
  if (process.platform === "darwin") koffi.struct("MigentTimeval", { tv_sec: "int64", tv_usec: "int32" });
  systemLib = loaded;
  return loaded;
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

function validTimeval(sec: number, usec: number): [number, number] | null {
  if (sec < 0 || (sec === 0 && usec === 0)) return null;
  return [sec, usec];
}

function num(value: number | bigint | undefined): number | null {
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function darwinBootTimeval(): [number, number] | null {
  try {
    if (sysctlByNameFn === null) {
      sysctlByNameFn = libc().func(
        "int sysctlbyname(const char *name, _Out_ MigentTimeval *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)",
      ) as unknown as (
        name: string,
        out: TimevalOut,
        size: Array<number | bigint>,
        newp: null,
        newlen: number,
      ) => number;
    }
    const size: Array<number | bigint> = [16n];
    const out: TimevalOut = {};
    const rc = sysctlByNameFn("kern.boottime", out, size, null, 0);
    if (rc !== 0) return null;
    const sec = num(out.tv_sec);
    const usec = num(out.tv_usec);
    if (sec === null || usec === null) return null;
    return validTimeval(sec, usec);
  } catch {
    return null;
  }
}

function darwinProcStart(pid: number): [number, number] | null {
  try {
    if (procPidinfoFn === null) {
      procPidinfoFn = libc().func(
        "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
      ) as unknown as (
        pid: number,
        flavor: number,
        arg: number,
        buffer: Buffer,
        size: number,
      ) => number;
    }
    const buf = Buffer.alloc(DARWIN_PROC_BSDINFO_SIZE);
    const wrote = procPidinfoFn(pid, PROC_PIDTBSDINFO, 0, buf, DARWIN_PROC_BSDINFO_SIZE);
    if (wrote >= DARWIN_PROC_BSDINFO_SIZE) {
      const sec = Number(buf.readBigUInt64LE(DARWIN_START_TIME_OFFSET));
      const usec = Number(buf.readBigUInt64LE(DARWIN_START_TIME_OFFSET + 8));
      if (Number.isFinite(sec) && Number.isFinite(usec)) return [sec, usec];
    }
  } catch {
    // fall through to kinfo
  }
  return darwinKinfoStart(pid);
}

function darwinKinfoStart(pid: number): [number, number] | null {
  try {
    const sysctl = libc().func(
      "int sysctl(int *name, unsigned int namelen, void *oldp, _Inout_ size_t *oldlenp, void *newp, size_t newlen)",
    ) as unknown as (
      name: number[],
      namelen: number,
      oldp: Buffer,
      oldlen: Array<number | bigint>,
      newp: null,
      newlen: number,
    ) => number;
    const buf = Buffer.alloc(DARWIN_KINFO_BUF);
    const size: Array<number | bigint> = [BigInt(DARWIN_KINFO_BUF)];
    const rc = sysctl([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid], 4, buf, size, null, 0);
    if (rc !== 0) return null;
    const wrote = num(size[0] ?? null);
    if (wrote === null || wrote < 12) return null;
    const sec = Number(readI64(buf, 0));
    const usec = readI32(buf, 8);
    return validTimeval(sec, usec);
  } catch {
    return null;
  }
}

function linuxBootId(): string | null {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "ascii").trim();
    return bootId || null;
  } catch {
    return null;
  }
}

function linuxProcessIdentity(pid: number): string | null {
  const bootId = linuxBootId();
  if (bootId === null) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "ascii");
  } catch {
    return null;
  }
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
  if (fields.length < 20 || !fields[19]) return null;
  return `linux:${bootId}:${fields[19]}`;
}

export function currentBootId(): string | null {
  if (process.platform === "linux") return linuxBootId();
  if (process.platform === "darwin") {
    const boot = darwinBootTimeval();
    if (boot === null) return null;
    return `darwin:${boot[0]}:${boot[1]}`;
  }
  return null;
}

export function kernelProcessIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") return linuxProcessIdentity(pid);
    if (process.platform === "darwin") {
      const boot = darwinBootTimeval();
      const start = darwinProcStart(pid);
      if (boot === null || start === null) return null;
      return `darwin:${boot[0]}:${boot[1]}:${start[0]}:${start[1]}`;
    }
  } catch {
    return null;
  }
  return null;
}

/** F_GETLK through variadic fcntl(2) so the holder pid comes back in the flock struct. */
export function identityLockHolder(filePath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, fsConstants.O_RDWR);
  } catch {
    return null;
  }
  try {
    const buf = packFlock(POSIX.F_WRLCK);
    const rc = fcntlFlockStruct(fd, POSIX.F_GETLK, buf);
    if (rc !== 0) return null;
    const decoded = unpackFlock(buf);
    if (decoded.lType === POSIX.F_UNLCK || decoded.lPid <= 0) return null;
    return decoded.lPid;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
