// Writes the generated schema and reference files. Run `pnpm build` first (`pnpm generate` does).
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { generateAll } = await import("../packages/contracts/dist/generate/index.js");
const files = generateAll();

for (const dir of ["packages/contracts/schemas", "docs/reference"]) rmSync(path.join(root, dir), { recursive: true, force: true });
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
console.log(`Wrote ${Object.keys(files).length} files.`);
