// Tests exercise code that writes progress straight to process.stdout/stderr,
// which vitest's `silent` option does not intercept. Drop it so only failures show.
const noop = (): boolean => true;
process.stdout.write = noop as typeof process.stdout.write;
process.stderr.write = noop as typeof process.stderr.write;

// Workflow tests run a scripted provider whose CLI is not installed. `main` resets the hooks after
// every call, so a getter keeps "every command is found" as the default for the session preflight
// of `session run`. Tests that care assign their own `which`.
import { cliHooks } from "../packages/cli/src/hooks.ts";

let injected: typeof cliHooks.which = null;
Object.defineProperty(cliHooks, "which", {
  get: () => injected ?? ((command: string) => `/fake/${command}`),
  set: (value: typeof cliHooks.which) => { injected = value; },
});
