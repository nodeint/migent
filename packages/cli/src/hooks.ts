import type { TSchema } from '@nodeint/migent-contracts';
import type { AgentToolRunner } from '@nodeint/migent-engine';

import type { RunCommand } from './client.js';
import type { SkillRunner } from './commands/skill.js';

/** Test seams. Production leaves all of them null. */
export const cliHooks: {
  which: ((command: string) => string | null) | null;
  runner: AgentToolRunner | null;
  runCommand: RunCommand | null;
  skillRunner: SkillRunner | null;
  /** Validates every JSON payload against its contract. Tests only. */
  validateJson: ((schema: TSchema, value: unknown) => void) | null;
  /** Answers the `session delete` confirmation. Tests only. */
  confirm: ((message: string) => boolean | Promise<boolean>) | null;
  /** Overrides the terminal check for prompts. Tests only. */
  interactive: boolean | null;
} = {
  which: null,
  runner: null,
  runCommand: null,
  skillRunner: null,
  validateJson: null,
  confirm: null,
  interactive: null,
};
