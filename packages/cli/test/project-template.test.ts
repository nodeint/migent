import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { loadWorkflowDocument } from "@nodeint/migent-kernel";
import { renderProject, projectTemplateDirectory, type ModelChoice } from "../src/project-template.js";

const root = new URL("../../../templates/", import.meta.url);
const choice = (provider: string, model: string, options: Record<string, string> = {}): ModelChoice => ({ provider, model, options });
const models = {
  planner: choice("codex", "gpt-5", { model_reasoning_effort: "high" }),
  reviewer: choice("grok", "123"),
  developer: choice("claude", "true"),
};

test("renders config models independently and keeps template content", () => {
  const files = renderProject(models);
  const config = parse(files[0]!.content) as { roles: Record<string, { default_model?: unknown; instructions: string[] }> };
  const local = parse(files[1]!.content) as { roles: Record<string, { default_model: unknown }> };
  const template = parse(readFileSync(new URL("config.yaml", root), "utf8")) as typeof config;
  expect(local.roles.planner?.default_model).toEqual({ provider: "codex", model: "gpt-5", options: { model_reasoning_effort: "high" } });
  expect(local.roles.reviewer?.default_model).toEqual({ provider: "grok", model: "123" });
  expect(local.roles.developer?.default_model).toEqual({ provider: "claude", model: "true" });
  for (const role of ["planner", "reviewer", "developer"]) {
    expect(config.roles[role]?.instructions).toEqual(template.roles[role]?.instructions);
    expect(config.roles[role]?.default_model).toBeUndefined();
  }
  expect(files[0]!.content).not.toContain("{{");
});

test("copies workflows byte for byte and they validate", () => {
  const files = renderProject(models);
  expect(files.map((file) => file.path)).toEqual([
    ".migent/config.yaml", ".migent/config.local.yaml", ".migent/workflows/implement.yaml", ".migent/workflows/plan.yaml", ".migent/.gitignore",
  ]);
  for (const name of ["implement", "plan"]) {
    const file = files.find((item) => item.path.endsWith(`${name}.yaml`) && item.path.includes("workflows"))!;
    expect(file.content).toBe(readFileSync(new URL(`workflows/${name}.yaml`, root), "utf8"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "migent-tpl-"));
    try {
      cpSync(new URL(`workflows/${name}.yaml`, root), path.join(dir, `${name}.yaml`));
      expect(loadWorkflowDocument(path.join(dir, `${name}.yaml`)).id).toBe(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("missing assets and missing role nodes fail naming the asset", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migent-tpl-"));
  try {
    expect(() => renderProject(models, dir)).toThrow(/config\.yaml/);
    cpSync(new URL(".", root), dir, { recursive: true });
    cpSync(path.join(dir, "config.yaml"), path.join(dir, "orig.yaml"));
    rmSync(path.join(dir, "workflows", "plan.yaml"));
    expect(() => renderProject(models, dir)).toThrow(/workflows\/plan\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a template without a role fails with the role path", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migent-tpl-"));
  try {
    cpSync(new URL(".", root), dir, { recursive: true });
    cpSync(new URL("workflows/plan.yaml", root), path.join(dir, "config.local.yaml"));
    expect(() => renderProject(models, dir)).toThrow(/roles\.planner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a template without default_model fails with the full node path", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migent-tpl-"));
  try {
    cpSync(new URL(".", root), dir, { recursive: true });
    const config = readFileSync(path.join(dir, "config.local.yaml"), "utf8").replace('    default_model: "{{planner.default_model}}"', '    other: value');
    writeFileSync(path.join(dir, "config.local.yaml"), config);
    expect(() => renderProject(models, dir)).toThrow(/roles\.planner\.default_model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong model placeholder fails with the full node path", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migent-tpl-"));
  try {
    cpSync(new URL(".", root), dir, { recursive: true });
    const config = readFileSync(path.join(dir, "config.local.yaml"), "utf8").replace("{{planner.default_model}}", "{{reviewer.default_model}}");
    writeFileSync(path.join(dir, "config.local.yaml"), config);
    expect(() => renderProject(models, dir)).toThrow(/roles\.planner\.default_model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source layout reads root templates; compiled layout never falls back", () => {
  expect(projectTemplateDirectory()).toBe(path.resolve(fileURLToPath(root)));
  const dir = mkdtempSync(path.join(os.tmpdir(), "migent-dist-"));
  try {
    const module = pathToFileURL(path.join(dir, "project-template.js")).href;
    expect(() => projectTemplateDirectory(module)).toThrow(/Packaged project templates are missing/);
    cpSync(new URL(".", root), path.join(dir, "templates", "project"), { recursive: true });
    expect(projectTemplateDirectory(module)).toBe(path.join(dir, "templates", "project"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
