import {
  CancellationRequested,
  raiseCancellation,
  resetCancellation,
  type SessionLock,
} from "@nodeint/migent-kernel";

let pending: CancellationRequested | null = null;
const waiters = new Set<() => void>();

function note(signalNumber: number): void {
  pending = new CancellationRequested(signalNumber);
  for (const waiter of waiters) waiter();
  try {
    raiseCancellation(signalNumber);
  } catch {
    // The pending flag is what the follow loop and provider runner observe.
  }
}

/** `lock` also lets `migent session cancel` stop the run, which is the only stop on Windows. */
export function bindCancellationSignals(lock?: SessionLock): () => void {
  const onSigint = () => note(2);
  const onSigterm = () => note(15);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  lock?.onCancelRequest(onSigint);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    pending = null;
    resetCancellation();
  };
}

export function throwIfCliCancelled(): void {
  const error = pending;
  if (error === null) return;
  pending = null;
  throw error;
}

export function delay(ms: number): Promise<void> {
  throwIfCliCancelled();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(wake);
      try {
        throwIfCliCancelled();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(finish, ms);
    const wake = () => finish();
    waiters.add(wake);
  });
}
