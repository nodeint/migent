import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printError } from "../display.js";
import { isDirectory, isFile } from "../fs-utils.js";

const SKILL_RELATIVE = path.join(".agents", "skills", "migent");
const STATE_FILENAME = ".migent-template.json";
const TEMPLATE_VERSION = 1;
const MANAGED = ["SKILL.md", "references/schema-config.yaml", "references/schema-workflow.yaml"] as const;

export function installSkill(workspace: string): number {
  const skillDirectory = path.join(workspace, SKILL_RELATIVE);
  if (existsSync(skillDirectory)) {
    printError(`${displayPath(skillDirectory, workspace)} already exists; use \`migent skill update\`.`);
    return 1;
  }
  mkdirSync(skillDirectory, { recursive: true });
  writeManagedSkill(skillDirectory, readTemplate());
  process.stdout.write(`Installed ${displayPath(skillDirectory, workspace)}\n`);
  return 0;
}

export function updateSkill(workspace: string, options: { force?: boolean } = {}): number {
  const skillDirectory = path.join(workspace, SKILL_RELATIVE);
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const statePath = path.join(skillDirectory, STATE_FILENAME);
  if (!isDirectory(skillDirectory) || !isFile(skillPath)) {
    printError("Migent skill is not installed; run `migent skill install`.");
    return 1;
  }
  const state = readState(statePath);
  if (state === null) {
    printError(
      "Existing Migent skill is not managed by Migent; move it aside and run `migent skill install`.",
    );
    return 1;
  }
  const installedDigest = state.content_sha256;
  if (typeof installedDigest !== "string") {
    printError("Existing Migent skill is not managed by Migent; move it aside and run `migent skill install`.");
    return 1;
  }
  const installed = readInstalled(skillDirectory);
  if (hasLocalChanges(installed, installedDigest) && !options.force) {
    printError("Migent skill has local changes; rerun with `migent skill update --force` to replace them.");
    return 1;
  }
  const template = readTemplate();
  if (bundleDigest(installed) === bundleDigest(template) && state.template_version === TEMPLATE_VERSION) {
    process.stdout.write(`Already up to date: ${displayPath(skillDirectory, workspace)}\n`);
    return 0;
  }
  writeManagedSkill(skillDirectory, template);
  process.stdout.write(`Updated ${displayPath(skillDirectory, workspace)}\n`);
  return 0;
}

function readTemplate(): Array<[string, string]> {
  const root = fileURLToPath(new URL("../templates/migent/", import.meta.url));
  return MANAGED.map((name) => [name, readFileSync(path.join(root, name), "utf8")]);
}

function readInstalled(skillDirectory: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const name of MANAGED) {
    const filePath = path.join(skillDirectory, name);
    if (!isFile(filePath)) continue;
    entries.push([name, readFileSync(filePath, "utf8")]);
  }
  return entries;
}

function hasLocalChanges(installed: ReadonlyArray<readonly [string, string]>, installedDigest: string): boolean {
  if (bundleDigest(installed) === installedDigest) return false;
  const skill = installed.find(([name]) => name === "SKILL.md");
  const references = installed.filter(([name]) => name !== "SKILL.md");
  return !(skill !== undefined && references.length === 0 && skillOnlyDigest(skill[1]) === installedDigest);
}

function writeManagedSkill(skillDirectory: string, entries: ReadonlyArray<readonly [string, string]>): void {
  for (const [name, content] of entries) {
    const filePath = path.join(skillDirectory, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
  const state = {
    schema_version: 1,
    template_version: TEMPLATE_VERSION,
    content_sha256: bundleDigest(entries),
  };
  writeFileSync(path.join(skillDirectory, STATE_FILENAME), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readState(filePath: string): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(payload) || payload.schema_version !== 1) return null;
    return payload;
  } catch {
    return null;
  }
}

function bundleDigest(entries: ReadonlyArray<readonly [string, string]>): string {
  const hash = createHash("sha256");
  for (const [name, content] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function skillOnlyDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function displayPath(filePath: string, workspace: string): string {
  return path.relative(workspace, filePath).split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
