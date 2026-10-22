import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ProviderCommandFailed } from "../src/provider.js";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

// Fake model outputs per adapter's parseModelCatalog expected format

// codex: JSON with models array containing slug
function fakeCodexOutput(models: string[]): string {
  return JSON.stringify({
    models: models.map((slug) => ({ slug, visibility: "list" })),
  });
}

// claude: any string containing a version number like "1.2.3"
function fakeClaudeOutput(): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "migent-models",
      response: {
        models: [
          { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
        ],
      },
    },
  });
}

// grok: lines with * prefix and optional "(default)"
function fakeGrokOutput(models: string[], defaultId?: string): string {
  const lines = ["Available models:"];
  for (const m of models) {
    const marked = m === defaultId ? `${m} (default)` : m;
    lines.push(`* ${marked}`);
  }
  if (defaultId) {
    lines.push(`Default model: ${defaultId}`);
  }
  return lines.join("\n");
}

// opencode: one model per line
function fakeOpencodeOutput(models: string[]): string {
  return models.join("\n");
}

// agy: one model per line (modelId format)
function fakeAgyOutput(models: string[]): string {
  return models.join("\n");
}

interface CommandCall {
  argv: string[];
}

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-cli-"));
}

function createFakeRunCommand(calledCommands: CommandCall[]): (argv: string[]) => string {
  return (argv: string[]): string => {
    calledCommands.push({ argv: [...argv] });
    const cmd = argv[0];
    switch (cmd) {
      case "codex":
        return fakeCodexOutput(["gpt-5", "gpt-4o"]);
      case "claude":
        return fakeClaudeOutput();
      case "grok":
        return fakeGrokOutput(["grok-4", "grok-3"], "grok-4");
      case "opencode":
        return fakeOpencodeOutput(["dola-2.0"]);
      case "agy":
        return fakeAgyOutput(["agi-pro"]);
      default:
        return "";
    }
  };
}

test("provider list lists every adapter from a cwd with no .migent/", async () => {
  const workspace = createTempDir();
  const calledCommands: CommandCall[] = [];
  try {
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = createFakeRunCommand(calledCommands);
    const captured = await capture(() => main(["provider", "list", "--json"], workspace));
    expect(captured.value).toBe(0);
    const payload = JSON.parse(captured.stdout) as {
      ok: boolean;
      providers: Array<{ name: string; command: string; path: string | null }>;
    };
    const providerNames = payload.providers.map((p) => p.name);
    expect(providerNames).toEqual(["agy", "claude", "codex", "grok", "opencode"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("provider list --json shape includes all expected fields", async () => {
  const workspace = createTempDir();
  const calledCommands: CommandCall[] = [];
  try {
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = createFakeRunCommand(calledCommands);
    const captured = await capture(() => main(["provider", "list", "--json"], workspace));
    const payload = JSON.parse(captured.stdout) as {
      ok: boolean;
      providers: Array<{
        name: string;
        command: string;
        path: string | null;
        available: boolean;
        models: string[];
        default_model: string | null;
        options: Array<{ name: string; prompt: boolean; allow_default: boolean; overridable: boolean }>;
        problems: string[];
      }>;
    };
    expect(payload.ok).toBe(true);
    const codex = payload.providers.find((p) => p.name === "codex");
    expect(codex).toBeDefined();
    expect(codex?.path).toBe("/bin/codex");
    expect(codex?.available).toBe(true);
    expect(codex?.models).toContain("gpt-5");
    const reasoningOption = codex?.options.find((o) => o.name === "model_reasoning_effort");
    expect(reasoningOption).toBeDefined();
    expect(reasoningOption?.prompt).toBe(true);
    expect(reasoningOption?.allow_default).toBe(true);
    expect(reasoningOption?.overridable).toBe(true);
    const grok = payload.providers.find((p) => p.name === "grok");
    expect(grok?.default_model).toBe("grok-4");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("missing CLI reports path: null and a problem, and does not call runCommand", async () => {
  const workspace = createTempDir();
  const calledCommands: CommandCall[] = [];
  try {
    cliHooks.which = (command: string) => (command === "codex" ? "/bin/codex" : null);
    cliHooks.runCommand = (argv: string[]) => {
      calledCommands.push({ argv: [...argv] });
      if (argv[0] === "codex") return fakeCodexOutput(["gpt-5"]);
      return "";
    };
    const captured = await capture(() => main(["provider", "list", "--json"], workspace));
    const payload = JSON.parse(captured.stdout) as {
      providers: Array<{ name: string; path: string | null; problems: string[]; available: boolean }>;
    };
    const codex = payload.providers.find((p) => p.name === "codex");
    expect(codex?.path).toBe("/bin/codex");
    expect(codex?.available).toBe(true);
    expect(codex?.problems).toEqual([]);
    const claude = payload.providers.find((p) => p.name === "claude");
    expect(claude?.path).toBe(null);
    expect(claude?.available).toBe(false);
    expect(claude?.problems).toContainEqual(expect.stringContaining("not on PATH"));
    const commandsCalled = calledCommands.map((c) => c.argv[0]);
    expect(commandsCalled).toEqual(["codex"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("runCommand failure is reported as a problem; other providers unaffected", async () => {
  const workspace = createTempDir();
  try {
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = (argv: string[]) => {
      if (argv[0] === "codex") {
        throw new ProviderCommandFailed("codex failed to list models.");
      }
      if (argv[0] === "claude") {
        throw new Error("generic failure");
      }
      if (argv[0] === "grok") {
        return fakeGrokOutput(["grok-4"]);
      }
      return "";
    };
    const captured = await capture(() => main(["provider", "list", "--json"], workspace));
    const payload = JSON.parse(captured.stdout) as {
      ok: boolean;
      providers: Array<{ name: string; problems: string[]; models: string[] }>;
    };
    const codex = payload.providers.find((p) => p.name === "codex");
    expect(codex?.problems).toContainEqual(expect.stringContaining("failed"));
    expect(codex?.models).toEqual([]);
    const claude = payload.providers.find((p) => p.name === "claude");
    expect(claude?.problems).toContainEqual(expect.stringContaining("generic"));
    const grok = payload.providers.find((p) => p.name === "grok");
    expect(grok?.problems).toEqual([]);
    expect(grok?.models).toContain("grok-4");
    expect(payload.ok).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("empty listing (zero models) is reported as a problem", async () => {
  const workspace = createTempDir();
  try {
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = (argv: string[]) => {
      if (argv[0] === "opencode") {
        return fakeOpencodeOutput([]);
      }
      if (argv[0] === "grok") {
        return fakeGrokOutput(["grok-4"]);
      }
      return "";
    };
    const captured = await capture(() => main(["provider", "list", "--json"], workspace));
    const payload = JSON.parse(captured.stdout) as {
      providers: Array<{ name: string; problems: string[]; models: string[] }>;
    };
    const opencode = payload.providers.find((p) => p.name === "opencode");
    expect(opencode?.problems.length).toBeGreaterThan(0);
    expect(opencode?.models).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("exit 0 when some providers fail; exit 1 when every provider has no models", async () => {
  const workspace = createTempDir();
  try {
    // Test 1: at least one provider has models -> exit 0
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = (argv: string[]) => {
      if (argv[0] === "codex") return fakeCodexOutput(["gpt-5"]);
      if (argv[0] === "claude") {
        throw new ProviderCommandFailed("failed");
      }
      return "";
    };
    const captured1 = await capture(() => main(["provider", "list", "--json"], workspace));
    expect(captured1.value).toBe(0);
  } finally {
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
  try {
    // Test 2: no provider has models -> exit 1
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = () => {
      throw new ProviderCommandFailed("failed");
    };
    const captured2 = await capture(() => main(["provider", "list", "--json"], workspace));
    expect(captured2.value).toBe(1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("text mode contains provider names, paths, model ids, and 'not found'", async () => {
  const workspace = createTempDir();
  try {
    cliHooks.which = (command: string) => (command === "codex" ? "/usr/local/bin/codex" : null);
    cliHooks.runCommand = (argv: string[]) => {
      if (argv[0] === "codex") return fakeCodexOutput(["gpt-5"]);
      return "";
    };
    const captured = await capture(() => main(["provider", "list"], workspace));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("codex");
    expect(captured.stdout).toContain("/usr/local/bin/codex");
    expect(captured.stdout).toContain("gpt-5");
    expect(captured.stdout).toContain("claude");
    expect(captured.stdout).toContain("not found");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("runCommand only receives each adapter's modelCatalogCommand argv", async () => {
  const workspace = createTempDir();
  const calledCommands: CommandCall[] = [];
  try {
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = (argv: string[]) => {
      calledCommands.push({ argv: [...argv] });
      return createFakeRunCommand([])(argv);
    };
    await capture(() => main(["provider", "list", "--json"], workspace));
    const codexCall = calledCommands.find((c) => c.argv[0] === "codex");
    expect(codexCall?.argv).toEqual(["codex", "debug", "models"]);
    const claudeCall = calledCommands.find((c) => c.argv[0] === "claude");
    expect(claudeCall?.argv).toEqual([
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    const grokCall = calledCommands.find((c) => c.argv[0] === "grok");
    expect(grokCall?.argv).toEqual(["grok", "models"]);
    const opencodeCall = calledCommands.find((c) => c.argv[0] === "opencode");
    expect(opencodeCall?.argv).toEqual(["opencode", "models"]);
    const agyCall = calledCommands.find((c) => c.argv[0] === "agy");
    expect(agyCall?.argv).toEqual(["agy", "models"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});

test("cliHooks.runCommand is reset after main() call", async () => {
  const workspace = createTempDir();
  try {
    cliHooks.which = (command: string) => `/bin/${command}`;
    cliHooks.runCommand = createFakeRunCommand([]);
    expect(cliHooks.runCommand).not.toBeNull();
    await capture(() => main(["provider", "list", "--json"], workspace));
    expect(cliHooks.runCommand).toBeNull();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cliHooks.which = null;
    cliHooks.runCommand = null;
  }
});
