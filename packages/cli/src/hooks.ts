import type { AgentToolRunner } from "@migent/kernel";

/** Test seams. Production leaves both null. */
export const cliHooks: {
  which: ((command: string) => string | null) | null;
  runner: AgentToolRunner | null;
} = {
  which: null,
  runner: null,
};
