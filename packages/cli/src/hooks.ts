import type { AgentToolRunner } from "@nodeint/migent-kernel";
import type { SkillRunner } from "./commands/skill.js";
import type { RunCommand } from "./provider.js";

/** Test seams. Production leaves all of them null. */
export const cliHooks: {
  which: ((command: string) => string | null) | null;
  runner: AgentToolRunner | null;
  runCommand: RunCommand | null;
  skillRunner: SkillRunner | null;
} = {
  which: null,
  runner: null,
  runCommand: null,
  skillRunner: null,
};
