import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isFile } from "./fs-utils.js";
import {
  groupByDirectory,
  SKILL_TARGETS,
  type SkillRoots,
  type SkillScope,
} from "./skill-targets.js";

export interface InstalledSkill {
  scope: SkillScope;
  directory: string;
  clients: string[];
  state: "current" | "different";
}

/** SHA-256 over every file under `directory`, sorted by relative path, CRLF read as LF. */
export function skillDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const relative of listFiles(directory)) {
    const content = readFileSync(path.join(directory, relative), "utf8").replace(/\r\n/g, "\n");
    hash.update(relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function isMigentSkill(directory: string): boolean {
  const skillPath = path.join(directory, "SKILL.md");
  if (!isFile(skillPath)) return false;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillPath, "utf8"));
  return match !== null && /^name:\s*["']?migent["']?\s*$/m.test(match[1] ?? "");
}

export function scanInstalledSkills(roots: SkillRoots, bundled: string): InstalledSkill[] {
  const expected = skillDigest(bundled);
  const found: InstalledSkill[] = [];
  for (const scope of ["project", "global"] as const) {
    for (const group of groupByDirectory(SKILL_TARGETS, scope, roots)) {
      if (!isMigentSkill(group.directory)) continue;
      found.push({
        scope,
        directory: group.directory,
        clients: group.targets.map((target) => target.client),
        state: skillDigest(group.directory) === expected ? "current" : "different",
      });
    }
  }
  return found;
}

function listFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}
