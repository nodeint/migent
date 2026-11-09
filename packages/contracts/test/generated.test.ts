import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as contracts from "../src/index.ts";
import { EXIT_CATALOG, SCHEMA_BASE } from "../src/index.ts";
import { collectIdentities, schemaPath } from "../src/generate/index.ts";
import { generateAll } from "../src/generate/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lf = (text: string) => text.replace(/\r\n/g, "\n");

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

const files = generateAll();
const schemaFiles = Object.keys(files).filter((name) => name.endsWith(".json"));

describe("generated files are current", () => {
  const fix = "Run `pnpm generate` and commit the result.";

  test("no missing, extra, or changed file", () => {
    const committed = [...listFiles(path.join(root, "packages/contracts/schemas")), ...listFiles(path.join(root, "docs/reference"))].sort();
    expect(committed, `File set differs. ${fix}`).toEqual(Object.keys(files).sort());
    for (const [relative, content] of Object.entries(files)) {
      expect(lf(readFileSync(path.join(root, relative), "utf8")), `${relative} is stale. ${fix}`).toBe(content);
    }
  });
});

describe("publication boundary", () => {
  test("one file per reachable identity, path mirrors $id", () => {
    const identities = [...collectIdentities().keys()];
    expect(schemaFiles.sort()).toEqual(identities.map((identity) => `packages/contracts/schemas/${schemaPath(identity)}`).sort());
    for (const identity of identities) expect(identity.startsWith(`${SCHEMA_BASE}/`)).toBe(true);
  });

  test("every exported identified schema is published (stage view included)", () => {
    const identities = new Set(collectIdentities().keys());
    for (const value of Object.values(contracts)) {
      const identity = (value as { $id?: unknown } | null)?.$id;
      if (typeof identity === "string") expect(identities.has(identity)).toBe(true);
    }
    expect(identities.has(`${SCHEMA_BASE}/common/stage-view.json`)).toBe(true);
    expect((contracts as Record<string, unknown>).StageView).toBeDefined();
  });

  test("no embedded $id below a root, every $ref resolves to a file", () => {
    const identities = new Set(collectIdentities().keys());
    const embedded: string[] = [];
    const refs: string[] = [];
    const visit = (value: unknown, atRoot: boolean) => {
      if (Array.isArray(value)) return value.forEach((item) => visit(item, false));
      if (typeof value !== "object" || value === null) return;
      for (const [key, item] of Object.entries(value)) {
        if (key === "$id" && !atRoot) embedded.push(String(item));
        else if (key === "$ref") refs.push(String(item));
        else visit(item, false);
      }
    };
    for (const name of schemaFiles) visit(JSON.parse(files[name]!), true);
    expect(embedded).toEqual([]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(identities.has(ref), ref).toBe(true);
  });

  test("each file declares its own $id and the dialect", () => {
    for (const name of schemaFiles) {
      const parsed = JSON.parse(files[name]!);
      expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(`packages/contracts/schemas/${schemaPath(parsed.$id)}`).toBe(name);
    }
  });
});

describe("exit catalog", () => {
  test("codes and names are unique", () => {
    expect(new Set(EXIT_CATALOG.map((entry) => entry.code)).size).toBe(EXIT_CATALOG.length);
    expect(new Set(EXIT_CATALOG.map((entry) => entry.name)).size).toBe(EXIT_CATALOG.length);
  });
});

describe("reference tables", () => {
  const cli = files["docs/reference/cli-output.md"]!;
  const workflow = files["docs/reference/workflow.md"]!;

  test("array element unions are grouped", () => {
    expect(cli).toContain("(string \\| number)[]");
    expect(cli).not.toMatch(/string \\\| number\[\]/);
    expect(workflow).toContain("(map of [Decision entry](#workflow-decision-entry-json))[]");
  });

  test("known shapes are marked opt-in", () => {
    expect(cli).toMatch(/Lifecycle event[^\n]*\n[\s\S]*?Opt-in description of a persisted file/);
    expect(cli.match(/Opt-in description of a persisted file/g)?.length).toBe(5);
  });
});
