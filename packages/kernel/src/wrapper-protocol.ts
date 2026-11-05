// The IPC contract between the owner and the process wrapper. The wrapper runs as
// `node process-wrapper.ts` from source, so this module holds only types and plain functions.
//
//   wrapper -> owner  {type: "ready"}   once the liveness endpoint is listening
//   owner -> wrapper  {type: "start"}   after the owner has recorded the endpoint
//   wrapper -> owner  {type: "failed"}  when the wrapper itself cannot go on

export const WRAPPER_READY = "ready";
export const WRAPPER_START = "start";
export const WRAPPER_FAILED = "failed";

/** The wrapper phase that failed. `ipc` can only ever reach the owner through stderr. */
export type WrapperPhase = "argv" | "ipc" | "listen" | "spawn" | "runtime";

const PHASES: readonly string[] = ["argv", "ipc", "listen", "spawn", "runtime"];

export interface WrapperFailedMessage {
  type: typeof WRAPPER_FAILED;
  phase: WrapperPhase;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

/** `code` the wrapper reports when the provider command line cannot be passed (Windows batch shims). */
export const UNPASSABLE_ARGUMENT_CODE = "UNPASSABLE_ARGUMENT";

/** Validates an incoming message. The owner never trusts an unchecked shape. */
export function parseFailedMessage(message: unknown): WrapperFailedMessage | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.type !== WRAPPER_FAILED) return null;
  if (typeof value.phase !== "string" || !PHASES.includes(value.phase)) return null;
  if (typeof value.message !== "string") return null;
  const parsed: WrapperFailedMessage = {
    type: WRAPPER_FAILED,
    phase: value.phase as WrapperPhase,
    message: value.message,
  };
  if (typeof value.code === "string") parsed.code = value.code;
  if (typeof value.errno === "number") parsed.errno = value.errno;
  if (typeof value.syscall === "string") parsed.syscall = value.syscall;
  if (typeof value.path === "string") parsed.path = value.path;
  return parsed;
}

export type WrapperReported = Omit<WrapperFailedMessage, "type"> & { kind: "wrapper-reported" };

/** The outcome of the start handshake, as the owner sees it. */
export type StartResult =
  | { kind: "ready" }
  | WrapperReported
  | { kind: "exited"; code: number | null; signal: string | null }
  | { kind: "spawn-error"; message: string; code?: string; errno?: number; syscall?: string; path?: string }
  | { kind: "cancelled" };

export type StartFailure = Exclude<StartResult, { kind: "ready" } | { kind: "cancelled" }>;
