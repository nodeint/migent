import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { stringifyConfig as stringify } from "@nodeint/migent-kernel";
import { runDoctor } from "../src/commands/doctor.ts";
import { ProviderCommandFailed, type RunCommand } from "../src/provider.ts";
import { capture } from "./support.ts";

const levels = ["low", "medium", "high"];
const which = (command: string) => `/fake/${command}`;

function fakeCatalog(argv: string[]): string {
  if (argv[0] === "codex") return JSON.stringify({ models: [{ slug: "test", supported_reasoning_levels: levels }] });
  if (argv[0] === "grok") {
    if (argv.includes("--reasoning-effort")) throw new ProviderCommandFailed("use one of: low, medium, high");
    return "Available models:\n  - test\n";
  }
  if (argv[0] === "claude") return JSON.stringify({ type: "control_response", response: { response: {
    models: [{ value: "test", supportedEffortLevels: levels }],
  } } });
  if (argv[0] === "agy") return "test\n";
  if (argv[0] === "opencode") return argv.includes("api")
    ? JSON.stringify({ data: [{ providerID: "custom", id: "test", variants: levels.map((id) => ({ id })) }] })
    : "custom/test\n";
  throw new Error(`Unexpected command: ${argv.join(" ")}`);
}

async function inspect(
  models: Record<string, unknown>,
  options: { run?: RunCommand; json?: boolean; local?: Record<string, unknown>; which?: typeof which } = {},
) {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-doctor-effort-"));
  try {
    mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
    writeFileSync(path.join(workspace, ".migent", "config.yaml"), stringify({
      schema_version: 2, models, roles: { developer: { default_model: Object.keys(models)[0] } },
    }));
    if (options.local) writeFileSync(path.join(workspace, ".migent", "config.local.yaml"), stringify(options.local));
    writeFileSync(path.join(workspace, ".migent", "workflows", "flow.yaml"), stringify({
      schema_version: 2, stages: [{ id: "work", role: "developer" }, { id: "again", role: "developer", depends_on: ["work"] }],
    }));
    return await capture(() => runDoctor(workspace, {
      asJson: options.json ?? true, which: options.which ?? which, runCommand: options.run ?? fakeCatalog, home: workspace,
    }));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

for (const provider of ["codex", "grok", "claude", "agy", "opencode"]) {
  test.each(["hgh", "", " ", null, 123, true, ["high"], { value: "high" }])(`${provider}: invalid effort %j includes valid values once`, async (effort) => {
    const result = await inspect({ fast: { provider, model: provider === "opencode" ? "custom/test" : "test", effort } });
    const body = JSON.parse(result.stdout);
    expect(result.value).toBe(1);
    const problems = body.checks.flatMap((check: { problems: string[] }) => check.problems);
    expect(problems).toEqual([`Invalid models.fast.effort: ${JSON.stringify(effort)}\nValid values: low, medium, high${provider === "agy" ? ", xhigh, max" : ""}`]);
  });
  test(`${provider}: valid effort passes`, async () => {
    const result = await inspect({ fast: { provider, model: provider === "opencode" ? "custom/test" : "test", effort: "high" } });
    expect(result.value).toBe(0);
    expect(JSON.parse(result.stdout).checks.flatMap((check: { warnings: string[] }) => check.warnings).join(" ")).not.toContain("Could not validate");
  });
}

test("ordinary output uses the same error and valid-value list", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "test", effort: "hgh" } }, { json: false });
  expect(result.value).toBe(1);
  expect(result.stdout).toContain('  Invalid models.fast.effort: "hgh"\n  Valid values: low, medium, high');
  expect(result.stdout).not.toContain("model_reasoning_effort");
});

test("multiple aliases reuse catalog requests and report all invalid values", async () => {
  const calls: string[][] = [];
  const result = await inspect({
    first: { provider: "codex", model: "test", effort: "bad" },
    second: { provider: "codex", model: "test", effort: "wrong" },
  }, { run: (argv) => { calls.push(argv); return fakeCatalog(argv); } });
  expect(result.value).toBe(1);
  expect(JSON.parse(result.stdout).checks[0].problems).toHaveLength(2);
  expect(calls).toHaveLength(1);
});

test("local effort and an alternate client select the correct catalog", async () => {
  const calls: string[][] = [];
  const result = await inspect({ fast: { provider: "byteplus", client: "grok", model: "test", effort: "bad" } }, {
    local: { models: { fast: { effort: "high" } } },
    run: (argv) => { calls.push(argv); return fakeCatalog(argv); },
  });
  expect(result.value).toBe(0);
  expect(calls.every((argv) => argv[0] === "grok")).toBe(true);
});

test("missing effort never queries a provider", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "test" } }, {
    run: () => { throw new Error("Must not query"); },
  });
  expect(result.value).toBe(0);
  expect(result.stdout).not.toContain("Could not validate");
});

test.each(["request timed out", "invalid catalog", "CLI unavailable"])("unverifiable effort warns without failing: %s", async (reason) => {
  const result = await inspect({ fast: { provider: "codex", model: "test", effort: "high" } }, {
    run: () => { throw new Error(reason); },
  });
  expect(result.value).toBe(0);
  const config = JSON.parse(result.stdout).checks[0];
  expect(config.problems).toEqual([]);
  expect(config.warnings).toEqual([expect.stringContaining('Could not validate models.fast.effort: "high"')]);
  expect(config.warnings[0]).toContain(reason);
});

test("empty supported levels means omit effort", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "test", effort: "high" } }, {
    run: () => JSON.stringify({ models: [{ slug: "test", supported_reasoning_levels: [] }] }),
  });
  expect(result.value).toBe(1);
  expect(JSON.parse(result.stdout).checks[0].problems).toEqual([
    'Invalid models.fast.effort: "high"\nValid values: none (omit effort)',
  ]);
});

test("absent supported-level metadata means unknown, not unsupported", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "test", effort: "high" } }, {
    run: () => JSON.stringify({ models: [{ slug: "test" }] }),
  });
  expect(result.value).toBe(0);
  expect(JSON.parse(result.stdout).checks[0].warnings[0]).toContain("Could not validate models.fast.effort");
});


test("empty effort still fails if supported values cannot be verified", async () => {
  const result = await inspect({ fast: { provider: "codex", model: "test", effort: "" } }, {
    run: () => { throw new Error("request timed out"); },
  });
  expect(result.value).toBe(1);
  const config = JSON.parse(result.stdout).checks[0];
  expect(config.problems).toEqual(['Invalid models.fast.effort: ""\nValid values: unavailable (could not verify)']);
  expect(config.warnings).toHaveLength(1);
});

test("catalog failures are cached across aliases", async () => {
  let calls = 0;
  const result = await inspect({
    first: { provider: "codex", model: "test", effort: "high" },
    second: { provider: "codex", model: "test", effort: "low" },
  }, { run: () => { calls++; throw new Error("request timed out"); } });
  expect(result.value).toBe(0);
  expect(calls).toBe(1);
  expect(JSON.parse(result.stdout).checks[0].warnings).toHaveLength(2);
});

test("a confirmed empty OpenCode variant list is an error, not a warning", async () => {
  const result = await inspect({ fast: { provider: "opencode", model: "custom/test", effort: "high" } }, {
    run: (argv) => argv.includes("api")
      ? JSON.stringify({ data: [{ providerID: "custom", id: "test", variants: [] }] })
      : fakeCatalog(argv),
  });
  expect(result.value).toBe(1);
  expect(JSON.parse(result.stdout).checks[0].problems).toEqual(['Invalid models.fast.effort: "high"\nValid values: none (omit effort)']);
});


test("validates the same trimmed identifiers and value used for execution", async () => {
  const result = await inspect({ fast: { provider: " byteplus ", client: " codex ", model: " test ", effort: " high " } });
  expect(result.value).toBe(0);
  expect(JSON.parse(result.stdout).checks[0].warnings).toEqual([]);
});
