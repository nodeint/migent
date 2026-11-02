import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

test("docs and skills no longer mention the removed config subcommands", () => {
  const targets = ["README.md", "docs", "skills"].map((item) => path.join(root, item));
  const pattern = /config (model|role|show)\b/;
  const offenders: string[] = [];
  const visit = (target: string): void => {
    if (statSync(target).isDirectory()) {
      for (const name of readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (!/\.(md|yaml)$/.test(target)) return;
    if (pattern.test(readFileSync(target, "utf8"))) offenders.push(path.relative(root, target));
  };
  for (const target of targets) visit(target);
  expect(offenders).toEqual([]);
});
