import { closeSync, writeFileSync } from "node:fs";
import { launchChild, readReadyLine } from "./child.js";
import { ensureRegistryHome } from "./home.js";
import { holdStartLock } from "./locks.js";
import { monotonic, sleep } from "./time.js";

export async function holdStartLockAfterChildReady(home: string, port: number, sentinel: string): Promise<void> {
  const directory = ensureRegistryHome(home);
  await holdStartLock(directory, 8, async () => {
    const [, parent] = await launchChild(directory, port);
    try {
      const line = await readReadyLine(parent, monotonic() + 5);
      if (!line) return;
      const payload = JSON.parse(line.toString("utf8")) as { pid?: unknown };
      writeFileSync(sentinel, String(payload.pid));
      await sleep(120);
    } finally {
      try {
        closeSync(parent);
      } catch {
        // already closed
      }
    }
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("hold-ready.ts") || entry.endsWith("hold-ready.js")) {
  const home = process.argv[2] ?? "";
  const port = Number(process.argv[3] ?? "0");
  const sentinel = process.argv[4] ?? "";
  await holdStartLockAfterChildReady(home, port, sentinel);
}
