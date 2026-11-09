import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

// JSON output is serialized in one module (emit.ts), so every payload has a contract.
test("no CLI source serializes JSON to stdout outside the emitter", () => {
  const offenders = sources(SRC)
    .filter((file) => path.basename(file) !== "emit.ts")
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return /process\.stdout\.write\(\s*`?\$\{JSON\.stringify|process\.stdout\.write\(\s*JSON\.stringify|options\.asJson === true \? `\$\{JSON\.stringify/.test(text);
    })
    .map((file) => path.relative(SRC, file));
  expect(offenders).toEqual([]);
});

test("get -o json is serialized by the emitter, not by the renderer", () => {
  expect(readFileSync(path.join(SRC, "get", "render.ts"), "utf8")).not.toContain("JSON.stringify");
});
