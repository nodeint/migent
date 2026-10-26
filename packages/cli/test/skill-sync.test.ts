import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

function files(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? files(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  }).sort();
}

test("the checked-in skill copy matches the bundled skill", () => {
  const bundled = path.join(root, "skills", "migent");
  const copy = path.join(root, ".agents", "skills", "migent");
  const names = files(bundled);
  expect(files(copy)).toEqual(names);
  for (const name of names) {
    const read = (base: string): string => readFileSync(path.join(base, name), "utf8").split("\r").join("");
    expect(read(copy), name).toBe(read(bundled));
  }
});

test("docs and skills no longer mention the removed config subcommands", () => {
  const targets = ["README.md", "docs", "skills", ".agents/skills"].map((item) => path.join(root, item));
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
