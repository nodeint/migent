import { writeFileSync } from "node:fs";
import { launchChild, readReadyLine } from "./child.js";
import { ensureRegistryHome } from "./home.js";
import { holdStartLock } from "./locks.js";
import { monotonic, sleep } from "./time.js";

/** Test helper: launch a service child, record its pid once ready, then wait to be killed. */
export async function holdStartLockAfterChildReady(home: string, port: number, sentinel: string): Promise<void> {
  const directory = ensureRegistryHome(home);
  await holdStartLock(directory, 8, async () => {
    const child = await launchChild(directory, port);
    const payload = await readReadyLine(child, monotonic() + 5);
    if (!payload) return;
    writeFileSync(sentinel, String(payload.pid));
    await sleep(120);
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("hold-ready.ts") || entry.endsWith("hold-ready.js")) {
  const home = process.argv[2] ?? "";
  const port = Number(process.argv[3] ?? "0");
  const sentinel = process.argv[4] ?? "";
  await holdStartLockAfterChildReady(home, port, sentinel);
}
