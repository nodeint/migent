import type { AgentToolRunner } from "@nodeint/migent-kernel";
import type { SkillRunner } from "./commands/skill.js";
import type { RunCommand } from "./client.js";
import type { TSchema } from "@nodeint/migent-contracts";

/** Test seams. Production leaves all of them null. */
export const cliHooks: {
  which: ((command: string) => string | null) | null;
  runner: AgentToolRunner | null;
  runCommand: RunCommand | null;
  skillRunner: SkillRunner | null;
  /** Validates every JSON payload against its contract. Tests only. */
  validateJson: ((schema: TSchema, value: unknown) => void) | null;
} = {
  which: null,
  runner: null,
  runCommand: null,
  skillRunner: null,
  validateJson: null,
};
