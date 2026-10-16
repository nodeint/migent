import { CancellationRequested, raiseCancellation } from "@nodeint/migent-kernel";

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

export function bindCancellationSignals(): () => void {
  const onSigint = () => note(2);
  const onSigterm = () => note(15);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    pending = null;
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
