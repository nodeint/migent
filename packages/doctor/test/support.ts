import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderInfo } from "@nodeint/migent-kernel";

const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const grokOptions = new Set([
  "reasoning-effort",
  "max_turns",
  "tools",
  "disallowed_tools",
  "permission_mode",
  "rules",
  "allow",
  "deny",
  "sandbox",
]);

export function defaultProviders(): Record<string, ProviderInfo> {
  return {
    codex: {
      command: "codex",
      validateOptions(options) {
        for (const [key, value] of Object.entries(options)) {
          if (!optionKey.test(key)) throw new Error(`${key} is not a codex option.`);
          if (value.trim() === "") throw new Error(`${key} is empty.`);
        }
      },
    },
    grok: {
      command: "grok",
      validateOptions(options) {
        for (const [key, value] of Object.entries(options)) {
          if (!grokOptions.has(key)) throw new Error(`${key} is not a grok option.`);
          if (value.trim() === "") throw new Error(`${key} is empty.`);
        }
      },
    },
  };
}

export function whichFound(found: ReadonlySet<string>): (command: string) => string | null {
  return (command) => (found.has(command) ? `/bin/${command}` : null);
}

export const STAGE_CONFIG = `\
models:
  grok:
    provider: grok
    model: grok-4.6
    options:
      reasoning-effort: high
  gpt-terra:
    provider: codex
    model: gpt-5.6-terra
    options:
      model_reasoning_effort: medium
      temperature: "0.2"
roles:
  developer:
    default_model: grok
  reviewer:
    default_model: gpt-terra
`;

export const STAGE_WORKFLOW = `\
id: plan-implement
stages:
  - id: implement
    role: developer
    depends_on: []
    produces:
      artifact: implementation-result.md
  - id: review-work
    role: reviewer
    model: gpt-terra
    options:
      model_reasoning_effort: high
    depends_on:
      - implement
`;

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function writeConfig(contents: string): string {
  const directory = tempDir("migent-config-");
  const filePath = path.join(directory, "config.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

export function writeStageWorkspace(): string {
  const workspace = tempDir("migent-stage-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), STAGE_CONFIG, "utf8");
  writeFileSync(path.join(workflows, "plan-implement.yaml"), STAGE_WORKFLOW, "utf8");
  return workspace;
}
