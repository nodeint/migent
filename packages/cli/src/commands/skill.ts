import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printError } from "../display.js";
import { isDirectory, isFile } from "../fs-utils.js";

const SKILL_RELATIVE = path.join(".agents", "skills", "migent");
const STATE_FILENAME = ".migent-template.json";
const TEMPLATE_VERSION = 1;

export function installSkill(workspace: string): number {
  const skillDirectory = path.join(workspace, SKILL_RELATIVE);
  if (existsSync(skillDirectory)) {
    printError(`${displayPath(skillDirectory, workspace)} already exists; use \`migent skill update\`.`);
    return 1;
  }
  const content = templateContent();
  mkdirSync(skillDirectory, { recursive: true });
  writeManagedSkill(skillDirectory, content);
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
  const current = readFileSync(skillPath, "utf8");
  const installedDigest = state.content_sha256;
  const currentDigest = digest(current);
  if (installedDigest !== currentDigest && !options.force) {
    printError("Migent skill has local changes; rerun with `migent skill update --force` to replace them.");
    return 1;
  }
  const content = templateContent();
  if (current === content && installedDigest === currentDigest && state.template_version === TEMPLATE_VERSION) {
    process.stdout.write(`Already up to date: ${displayPath(skillDirectory, workspace)}\n`);
    return 0;
  }
  writeManagedSkill(skillDirectory, content);
  process.stdout.write(`Updated ${displayPath(skillDirectory, workspace)}\n`);
  return 0;
}

function templateContent(): string {
  const nextToModule = fileURLToPath(new URL("../templates/migent/SKILL.md", import.meta.url));
  return readFileSync(nextToModule, "utf8");
}

function writeManagedSkill(skillDirectory: string, content: string): void {
  writeFileSync(path.join(skillDirectory, "SKILL.md"), content, "utf8");
  const state = {
    schema_version: 1,
    template_version: TEMPLATE_VERSION,
    content_sha256: digest(content),
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

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function displayPath(filePath: string, workspace: string): string {
  return path.relative(workspace, filePath).split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


