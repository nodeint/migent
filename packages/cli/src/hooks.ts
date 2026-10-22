import type { AgentToolRunner } from "@nodeint/migent-kernel";
import type { RunCommand } from "./provider.js";

/** Test seams. Production leaves both null. */
export const cliHooks: {
  which: ((command: string) => string | null) | null;
  runner: AgentToolRunner | null;
  runCommand: RunCommand | null;
} = {
  which: null,
  runner: null,
  runCommand: null,
};
