import { homedir } from "node:os";
import path from "node:path";

export type SkillScope = "project" | "global";

export interface SkillTarget {
  /** Migent client id, as in `clientIds()`. */
  client: string;
  /** Value for `skills -a`. */
  skillsAgent: string;
  /** Skill directory relative to the workspace. */
  project: string;
  /** Skill directory relative to the home directory. */
  global: string;
}

/**
 * Where each client reads skills, as written by `npx skills add`.
 * opencode and agy share `.agents/skills` with codex; the global path is where
 * `skills -g` puts them, which is not always where the client's own docs say.
 */
export const SKILL_TARGETS: readonly SkillTarget[] = [
  { client: "claude-code", skillsAgent: "claude-code", project: ".claude/skills", global: ".claude/skills" },
  { client: "codex", skillsAgent: "codex", project: ".agents/skills", global: ".agents/skills" },
  { client: "opencode", skillsAgent: "opencode", project: ".agents/skills", global: ".agents/skills" },
  { client: "agy", skillsAgent: "antigravity", project: ".agents/skills", global: ".agents/skills" },
  { client: "grok", skillsAgent: "grok", project: ".grok/skills", global: ".grok/skills" },
];

export interface SkillRoots {
  workspace: string;
  home?: string;
}

export function findTarget(client: string): SkillTarget | undefined {
  return SKILL_TARGETS.find((target) => target.client === client);
}

/** Absolute `<skills dir>/migent` for a target. */
export function resolveDirectory(target: SkillTarget, scope: SkillScope, roots: SkillRoots): string {
  const base = scope === "project" ? roots.workspace : (roots.home ?? homedir());
  return path.join(base, ...(scope === "project" ? target.project : target.global).split("/"), "migent");
}

/** Targets that resolve to the same directory, grouped, in table order. */
export function groupByDirectory(
  targets: readonly SkillTarget[],
  scope: SkillScope,
  roots: SkillRoots,
): Array<{ directory: string; targets: SkillTarget[] }> {
  const groups = new Map<string, SkillTarget[]>();
  for (const target of targets) {
    const directory = resolveDirectory(target, scope, roots);
    const members = groups.get(directory) ?? [];
    members.push(target);
    groups.set(directory, members);
  }
  return [...groups].map(([directory, members]) => ({ directory, targets: members }));
}
