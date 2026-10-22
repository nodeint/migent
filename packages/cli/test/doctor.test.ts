import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { capture, repoWorkflowText } from "./support.ts";

function whichBoth(command: string): string | null {
  if (command === "codex" || command === "grok") return `/bin/${command}`;
  return null;
}

function writeProject(workspace: string): void {
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  const config = `\
schema_version: 2
models:
  planner-model:
    provider: codex
    model: gpt-5
  reviewer-model:
    provider: grok
    model: grok-4
roles:
  planner:
    default_model: planner-model
  reviewer:
    default_model: reviewer-model
  developer:
    default_model: planner-model
`;
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), config, "utf8");
  writeFileSync(path.join(workflows, "plan.yaml"), repoWorkflowText("plan"), "utf8");
}

test("doctor passes from a project subdirectory", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeProject(workspace);
    const child = path.join(workspace, "src");
    mkdirSync(child);
    cliHooks.which = whichBoth;
    const captured = await capture(() => main(["doctor"], child));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("ok");
    expect(captured.stdout).toContain("developer");
    expect(captured.stdout).toContain("plan");
    expect(captured.stdout).toContain("/bin/grok");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("doctor json fails when a provider command is missing", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeProject(workspace);
    cliHooks.which = (command) => (command === "codex" ? "/bin/codex" : null);
    const captured = await capture(() => main(["doctor", "--json"], workspace));
    const payload = JSON.parse(captured.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; problems: string[]; items: string[] }>;
    };
    expect(captured.value).toBe(1);
    expect(payload.ok).toBe(false);
    const providers = payload.checks.find((check) => check.name === "providers");
    expect(providers?.problems).toEqual(["grok is not on PATH"]);
    expect(providers?.items).toContain("codex  /bin/codex");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("doctor stops when the schema is outdated", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeProject(workspace);
    const configPath = path.join(workspace, ".migent", "config.yaml");
    const original = readFileSync(configPath, "utf8").replace("schema_version: 2\n", "");
    writeFileSync(configPath, original, "utf8");
    const captured = await capture(() => main(["doctor"], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain("Run `migent migrate` to update.");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("doctor exits 2 when the workspace is missing", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    const captured = await capture(() => main(["doctor"], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain(".migent/config.yaml");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
