import { spawn, type StdioOptions } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { endianness, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface FsExt {
  fcntl(
    fd: number,
    cmd: number,
    arg: number,
    callback: (err: NodeJS.ErrnoException | null, result?: number) => void,
  ): void;
  fcntlSync(fd: number, cmd: number, arg?: number): number;
  constants: {
    F_GETFD: number;
    F_SETFD: number;
    F_GETLK: number;
    F_SETLK: number;
    F_SETLKW: number;
    F_RDLCK: number;
    F_WRLCK: number;
    F_UNLCK: number;
    FD_CLOEXEC: number;
  };
}

const fsExt = require("fs-ext") as FsExt;

/** POSIX F_GETFL / F_SETFL. fs-ext does not publish these; they are not flock ops. */
const F_GETFL = 3;
const F_SETFL = 4;

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

interface PipeOut {
  readFd?: number;
  writeFd?: number;
}

let systemLib: KoffiLib | null = null;
let fcntlVariadic: ((fd: number, cmd: number, typeName: string, buf: Buffer) => number) | null =
  null;
let pipeFn: ((out: PipeOut) => number) | null = null;
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
  if (process.platform === "darwin") {
    koffi.struct("MigentTimeval", { tv_sec: "int64", tv_usec: "int32" });
    koffi.struct("MigentPipeFds", { readFd: "int", writeFd: "int" });
  } else {
    koffi.struct("MigentPipeFds", { readFd: "int", writeFd: "int" });
  }
  systemLib = loaded;
  return loaded;
}

function fcntlCmd(): (fd: number, cmd: number, typeName: string, buf: Buffer) => number {
  if (fcntlVariadic !== null) return fcntlVariadic;
  // fcntl(2) is variadic. A non-variadic void* prototype passes a bad address (EFAULT).
  fcntlVariadic = libc().func("int fcntl(int fd, int cmd, ...)") as unknown as (
    fd: number,
    cmd: number,
    typeName: string,
    buf: Buffer,
  ) => number;
  return fcntlVariadic;
}

function writeI16(buf: Buffer, offset: number, value: number): void {
  if (endianness() === "LE") buf.writeInt16LE(value, offset);
  else buf.writeInt16BE(value, offset);
}

function writeI32(buf: Buffer, offset: number, value: number): void {
  if (endianness() === "LE") buf.writeInt32LE(value, offset);
  else buf.writeInt32BE(value, offset);
}

function writeI64(buf: Buffer, offset: number, value: bigint): void {
  if (endianness() === "LE") buf.writeBigInt64LE(value, offset);
  else buf.writeBigInt64BE(value, offset);
}

function readI16(buf: Buffer, offset: number): number {
  return endianness() === "LE" ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
}

function readI32(buf: Buffer, offset: number): number {
  return endianness() === "LE" ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
}

function readI64(buf: Buffer, offset: number): bigint {
  return endianness() === "LE" ? buf.readBigInt64LE(offset) : buf.readBigInt64BE(offset);
}

/** Darwin `struct flock` is `@qqihh` (24 bytes). Linux is `@hhqqi`. */
export function packFlock(
  lType: number,
  lWhence = 0,
  lStart = 0,
  lLen = 0,
  lPid = 0,
): Buffer {
  if (process.platform === "darwin") {
    const buf = Buffer.alloc(24);
    writeI64(buf, 0, BigInt(lStart));
    writeI64(buf, 8, BigInt(lLen));
    writeI32(buf, 16, lPid);
    writeI16(buf, 20, lType);
    writeI16(buf, 22, lWhence);
    return buf;
  }
  const buf = Buffer.alloc(32);
  writeI16(buf, 0, lType);
  writeI16(buf, 2, lWhence);
  writeI64(buf, 8, BigInt(lStart));
  writeI64(buf, 16, BigInt(lLen));
  writeI32(buf, 24, lPid);
  return buf;
}

export function unpackFlock(buf: Buffer): {
  lType: number;
  lWhence: number;
  lStart: bigint;
  lLen: bigint;
  lPid: number;
} {
  if (process.platform === "darwin") {
    return {
      lStart: readI64(buf, 0),
      lLen: readI64(buf, 8),
      lPid: readI32(buf, 16),
      lType: readI16(buf, 20),
      lWhence: readI16(buf, 22),
    };
  }
  return {
    lType: readI16(buf, 0),
    lWhence: readI16(buf, 2),
    lStart: readI64(buf, 8),
    lLen: readI64(buf, 16),
    lPid: readI32(buf, 24),
  };
}

function fcntlLock(fd: number, cmd: number, lockType: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.fcntl(fd, cmd, lockType, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function createPipe(): { readFd: number; writeFd: number } {
  if (pipeFn === null) {
    pipeFn = libc().func("int pipe(_Out_ MigentPipeFds *fds)") as unknown as (
      out: PipeOut,
    ) => number;
  }
  const out: PipeOut = {};
  const rc = pipeFn(out);
  if (rc !== 0 || out.readFd === undefined || out.writeFd === undefined) {
    const error = new Error("pipe failed") as NodeJS.ErrnoException;
    error.code = "EIO";
    throw error;
  }
  return { readFd: out.readFd, writeFd: out.writeFd };
}

export function setFdCloexec(fd: number): void {
  const flags = fsExt.fcntlSync(fd, fsExt.constants.F_GETFD);
  fsExt.fcntlSync(fd, fsExt.constants.F_SETFD, flags | fsExt.constants.FD_CLOEXEC);
}

export function clearFdCloexec(fd: number): void {
  const flags = fsExt.fcntlSync(fd, fsExt.constants.F_GETFD);
  fsExt.fcntlSync(fd, fsExt.constants.F_SETFD, flags & ~fsExt.constants.FD_CLOEXEC);
}

type StdioSlot = "pipe" | "inherit" | "ignore";

/** macOS posix_spawn closes fds that are not in the stdio file actions. */
export function stdioKeepingFd(
  fd: number,
  stdin: StdioSlot,
  stdout: StdioSlot,
  stderr: StdioSlot,
): StdioOptions {
  const length = Math.max(3, fd + 1);
  const stdio: unknown[] = Array.from({ length }, () => "ignore");
  stdio[0] = stdin;
  stdio[1] = stdout;
  stdio[2] = stderr;
  if (fd >= 3) stdio[fd] = fd;
  return stdio as StdioOptions;
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

/**
 * fs-ext async F_GETLK builds a zeroed flock (l_type F_UNLCK) and returns only
 * the syscall status, so the holder pid is not available. Match Python's
 * F_GETLK by passing an `@qqihh` flock through variadic fcntl(2).
 */
export function identityLockHolder(filePath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, fsConstants.O_RDWR);
  } catch {
    return null;
  }
  try {
    const buf = packFlock(fsExt.constants.F_WRLCK);
    const rc = fcntlCmd()(fd, fsExt.constants.F_GETLK, "uint8_t *", buf);
    if (rc !== 0) return null;
    const decoded = unpackFlock(buf);
    if (decoded.lType === fsExt.constants.F_UNLCK || decoded.lPid <= 0) return null;
    return decoded.lPid;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function acquireIdentityLock(filePath: string): Promise<number> {
  const fd = openSync(filePath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o600);
  try {
    await fcntlLock(fd, fsExt.constants.F_SETLKW, fsExt.constants.F_WRLCK);
    clearFdCloexec(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function writeIdentityPayload(fd: number, payload: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(payload));
  ftruncateSync(fd, 0);
  writeSync(fd, encoded, 0, encoded.length, 0);
  fsyncSync(fd);
}

function deathPipeAlreadyClosed(deathFd: number): boolean {
  const flags = fsExt.fcntlSync(deathFd, F_GETFL, 0);
  fsExt.fcntlSync(deathFd, F_SETFL, flags | fsConstants.O_NONBLOCK);
  let closed = false;
  try {
    const buf = Buffer.alloc(1);
    const n = readSync(deathFd, buf, 0, 1, null);
    closed = n === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EAGAIN" && code !== "EWOULDBLOCK") process.exit(1);
  } finally {
    fsExt.fcntlSync(deathFd, F_SETFL, flags & ~fsConstants.O_NONBLOCK);
  }
  return closed;
}

function sleepSec(seconds: number): void {
  const ms = Math.max(0, Math.round(seconds * 1000));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") process.exit(0);
    throw error;
  }
}

function runWatcher(deathFd: number, graceSec: number, pgid: number): void {
  process.on("SIGTERM", () => undefined);
  process.on("SIGHUP", () => undefined);
  const buf = Buffer.alloc(1);
  try {
    readSync(deathFd, buf, 0, 1, null);
  } catch {
    // Owner death is EOF or a closed fd. Either way the group stops.
  }
  try {
    killGroup(pgid, "SIGTERM");
  } catch {
    process.exit(0);
  }
  sleepSec(graceSec);
  try {
    killGroup(pgid, "SIGKILL");
  } catch {
    process.exit(0);
  }
  process.exit(0);
}

function runningAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const url = new URL(import.meta.url);
  url.search = "";
  url.hash = "";
  return path.resolve(entry) === path.resolve(fileURLToPath(url));
}

interface WrapperOptions {
  deathFd: number;
  identityPath: string;
  token: string;
  graceSec: number;
  command: string[];
}

function parseArgv(argv: string[]): WrapperOptions {
  const options: Record<string, string> = {};
  let index = 0;
  while (index < argv.length) {
    const item = argv[index];
    if (item === "--") {
      const command = argv.slice(index + 1);
      if (command.length === 0) process.exit(1);
      for (const key of ["death_fd", "identity_path", "token", "grace_sec"]) {
        if (options[key] === undefined) process.exit(1);
      }
      return {
        deathFd: Number(options.death_fd),
        identityPath: options.identity_path ?? "",
        token: options.token ?? "",
        graceSec: Number(options.grace_sec),
        command,
      };
    }
    if (
      item === "--death-fd" ||
      item === "--identity-path" ||
      item === "--token" ||
      item === "--grace-sec"
    ) {
      const value = argv[index + 1];
      if (value === undefined) process.exit(1);
      options[item.slice(2).replaceAll("-", "_")] = value;
      index += 2;
      continue;
    }
    process.exit(1);
  }
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "--watcher") {
    runWatcher(Number(argv[1]), Number(argv[2]), Number(argv[3]));
    return;
  }
  const options = parseArgv(argv);
  if (!Number.isInteger(options.deathFd) || options.deathFd < 0) process.exit(1);
  if (deathPipeAlreadyClosed(options.deathFd)) process.exit(1);
  const entry = process.argv[1];
  if (!entry) process.exit(1);
  const watcher = spawn(
    process.execPath,
    [path.resolve(entry), "--watcher", String(options.deathFd), String(options.graceSec), String(process.pid)],
    {
      detached: false,
      stdio: stdioKeepingFd(options.deathFd, "ignore", "ignore", "ignore"),
    },
  );
  watcher.unref();
  closeSync(options.deathFd);
  let lockFd: number;
  try {
    lockFd = await acquireIdentityLock(options.identityPath);
  } catch {
    process.exit(1);
  }
  const pid = process.pid;
  const pgid = posixGetpgid(pid) ?? pid;
  const payload = {
    token: options.token,
    pid,
    pgid,
    start_key: kernelProcessIdentity(pid),
    boot_id: currentBootId(),
    hostname: hostname(),
  };
  try {
    writeIdentityPayload(lockFd, payload);
  } catch {
    process.exit(1);
  }
  const command = spawn(options.command[0] ?? "", options.command.slice(1), {
    detached: false,
    stdio: "inherit",
  });
  command.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      process.stderr.write(`CLI executable not found: ${options.command[0]}\n`);
      process.exit(127);
    }
    process.exit(1);
  });
  command.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

if (runningAsMain()) {
  main(process.argv.slice(2)).catch(() => {
    process.exit(1);
  });
}

export function wrapperEntry(): string {
  const url = new URL(import.meta.url);
  url.search = "";
  url.hash = "";
  return fileURLToPath(url);
}
