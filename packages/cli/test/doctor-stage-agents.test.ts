import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { stringifyConfig as stringify } from "@nodeint/migent-kernel";
import { runDoctor } from "../src/commands/doctor.ts";
import { ProviderCommandFailed } from "../src/provider.ts";
import { capture } from "./support.ts";

const which = (command: string) => `/fake/${command}`;
const catalog = (argv: string[]): string => {
  if (argv[0] === "grok") {
    if (argv.includes("--reasoning-effort")) throw new ProviderCommandFailed("use one of: low, medium, high");
    return "Available models:\n  - grok-4\n";
  }
  throw new Error(`Unexpected command: ${argv.join(" ")}`);
};

async function inspect(roleExtra: Record<string, unknown>, stageAgent: unknown) {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-doctor-stage-agent-"));
  try {
    mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
    writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify({
      schema_version: 5,
      roles: { developer: { agent: { provider: "grok", model: "grok-4" }, ...roleExtra } },
    }));
    writeFileSync(path.join(workspace, ".migent", "workflows", "flow.yaml"), stringify({
      schema_version: 5,
      stages: [{ id: "work", role: "developer", ...(stageAgent === undefined ? {} : { agent: stageAgent }) }],
    }));
    const result = await capture(() => runDoctor(workspace, { asJson: true, which, runCommand: catalog, home: workspace }));
    const checks = JSON.parse(result.stdout).checks as Array<{ name: string; problems: string[]; items: string[] }>;
    return { code: result.value, checks };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("an inline stage agent with an unknown model is rejected like a named one", async () => {
  const bad = await inspect({}, { provider: "grok", model: "grok-4x" });
  expect(bad.code).toBe(1);
  const problems = bad.checks.find((check) => check.name === "workflows")?.problems.join("\n");
  expect(problems).toContain('flow.work: Invalid stages.work.agent.model: "grok-4x"');
  expect((await inspect({}, { provider: "grok", model: "grok-4" })).code).toBe(0);
});

test("an inline stage agent with an unsupported effort is rejected", async () => {
  const bad = await inspect({}, { provider: "grok", model: "grok-4", effort: "bogus" });
  expect(bad.code).toBe(1);
  expect(bad.checks.find((check) => check.name === "workflows")?.problems.join("\n")).toContain("stages.work.agent.effort");
});

test("role descriptions are validated and listed", async () => {
  const ok = await inspect({ description: "Builds it." }, undefined);
  expect(ok.code).toBe(0);
  expect(ok.checks.find((check) => check.name === "config")?.items).toContain("developer  Builds it.");
  const bad = await inspect({ description: "two\nlines" }, undefined);
  expect(bad.code).toBe(1);
  expect(bad.checks.find((check) => check.name === "config")?.problems.join("\n")).toContain("roles.developer.description must be one line.");
});
