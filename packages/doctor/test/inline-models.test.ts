import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test } from "vitest";
import { defaultProviders } from "@nodeint/migent-adapters";
import { diagnose } from "../src/index.ts";

const providers = defaultProviders();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { provider: "codex", model: "test-model", effort: "high", client: { options: { temperature: "0.2" } } };
const which = () => "/fake/provider";

function workspace(config: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), "migent-inline-"));
  roots.push(root);
  mkdirSync(path.join(root, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), stringify(config));
  return root;
}

test("an inline-only role passes the same model validation as an alias", () => {
  const checks = diagnose(workspace({ roles: { dev: { agent: model } } }), { providers, which });
  expect(checks[0].problems).toEqual([]);
  expect(checks[2].ok).toBe(true);
  expect(checks[2].items.join(" ")).toContain("codex");
});

test.each([{}, null, { temperature: "0.2" }])("removed role options are reported: %j", (options) => {
  const checks = diagnose(workspace({ roles: { dev: { agent: model, options } } }), { providers, which });
  expect(checks[0].problems.join(" ")).toContain("roles.dev.options is no longer supported");
});

test.each([
  { provider: "unknown", model: "test" },
  { provider: "byteplus", model: "test" },
  { provider: "codex", client: { type: "unknown" }, model: "test" },
])("inline provider and client are validated: %j", (definition) => {
  const checks = diagnose(workspace({ roles: { dev: { agent: definition } } }), { providers, which });
  expect(checks[0].ok).toBe(false);
  expect(checks[0].problems.join(" ")).toContain("roles.dev.agent");
});

test("an inline client selects the effective CLI", () => {
  const definition = { provider: "byteplus", client: { type: "codex" }, model: "test", effort: "high" };
  expect(diagnose(workspace({ roles: { dev: { agent: definition } } }), { providers, which })[0].ok).toBe(true);
});
