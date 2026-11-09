import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
