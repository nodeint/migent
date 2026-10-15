import { createRequire } from "node:module";
import { constants as osConstants, endianness } from "node:os";

const require = createRequire(import.meta.url);

interface KoffiLib {
  func(definition: string): (...args: never[]) => unknown;
}

interface Koffi {
  load(name: string): KoffiLib;
  errno(): number;
}

type FcntlFn = (fd: number, cmd: number, typeName: string, arg: number | Buffer) => number;

const darwin = process.platform === "darwin";

/** fcntl(2) and flock(2) constants. Lock commands and types differ between Darwin and Linux. */
export const POSIX = {
  F_GETFD: 1,
  F_SETFD: 2,
  F_GETFL: 3,
  F_SETFL: 4,
  F_GETLK: darwin ? 7 : 5,
  F_SETLK: darwin ? 8 : 6,
  F_SETLKW: darwin ? 9 : 7,
  F_RDLCK: darwin ? 1 : 0,
  F_UNLCK: 2,
  F_WRLCK: darwin ? 3 : 1,
  FD_CLOEXEC: 1,
  LOCK_SH: 1,
  LOCK_EX: 2,
  LOCK_NB: 4,
  LOCK_UN: 8,
} as const;

const SETLKW_POLL_MIN_MS = 5;
const SETLKW_POLL_MAX_MS = 100;

let koffiModule: Koffi | null = null;
let systemLib: KoffiLib | null = null;
let fcntlFn: FcntlFn | null = null;
let flockFn: ((fd: number, operation: number) => number) | null = null;

function koffi(): Koffi {
  if (koffiModule === null) koffiModule = require("koffi") as Koffi;
  return koffiModule;
}

function libc(): KoffiLib {
  if (systemLib === null) {
    systemLib = koffi().load(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6");
  }
  return systemLib;
}

function fcntlCall(): FcntlFn {
  if (fcntlFn !== null) return fcntlFn;
  // fcntl(2) is variadic. A non-variadic void* prototype passes a bad address (EFAULT).
  fcntlFn = libc().func("int fcntl(int fd, int cmd, ...)") as unknown as FcntlFn;
  return fcntlFn;
}

const errnoNames = new Map<number, string>();
for (const [name, value] of Object.entries(osConstants.errno)) {
  if (!errnoNames.has(value)) errnoNames.set(value, name);
}

function errnoError(syscall: string): NodeJS.ErrnoException {
  const errno = koffi().errno();
  const code = errnoNames.get(errno) ?? "EIO";
  const error = new Error(`${code}, ${syscall} failed`) as NodeJS.ErrnoException;
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  return error;
}

function isContention(error: unknown): boolean {
  const errno = (error as NodeJS.ErrnoException).errno;
  return (
    errno === osConstants.errno.EAGAIN ||
    errno === osConstants.errno.EACCES ||
    errno === osConstants.errno.EWOULDBLOCK
  );
}

/** fcntl(fd, cmd, int). Throws an ErrnoException when the call fails. */
export function fcntlInt(fd: number, cmd: number, arg = 0): number {
  const rc = fcntlCall()(fd, cmd, "int", arg);
  if (rc === -1) throw errnoError("fcntl");
  return rc;
}

/** fcntl(fd, cmd, struct flock *). Returns the raw status; errno is left for the caller. */
export function fcntlFlockStruct(fd: number, cmd: number, buf: Buffer): number {
  return fcntlCall()(fd, cmd, "uint8_t *", buf);
}

/** Whole-file F_SETLK. Throws EAGAIN/EACCES when another process holds a conflicting lock. */
export function fcntlSetLock(fd: number, lockType: number): void {
  if (fcntlFlockStruct(fd, POSIX.F_SETLK, packFlock(lockType)) === -1) throw errnoError("fcntl");
}

/**
 * Whole-file fcntl lock. F_SETLK fails fast on contention. F_SETLKW waits by polling F_SETLK
 * so the event loop is never blocked inside the syscall.
 */
export async function fcntlLock(fd: number, cmd: number, lockType: number): Promise<void> {
  if (cmd === POSIX.F_SETLK) {
    fcntlSetLock(fd, lockType);
    return;
  }
  if (cmd !== POSIX.F_SETLKW) throw new Error(`unsupported fcntl lock command ${cmd}`);
  let delay = SETLKW_POLL_MIN_MS;
  for (;;) {
    try {
      fcntlSetLock(fd, lockType);
      return;
    } catch (error) {
      if (!isContention(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, SETLKW_POLL_MAX_MS);
  }
}

/** flock(2). Blocks unless `operation` includes LOCK_NB. */
export function flockSync(fd: number, operation: number): void {
  if (flockFn === null) {
    flockFn = libc().func("int flock(int fd, int operation)") as unknown as (fd: number, operation: number) => number;
  }
  if (flockFn(fd, operation) === -1) throw errnoError("flock");
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

export function readI32(buf: Buffer, offset: number): number {
  return endianness() === "LE" ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
}

export function readI64(buf: Buffer, offset: number): bigint {
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
  if (darwin) {
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
  if (darwin) {
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
