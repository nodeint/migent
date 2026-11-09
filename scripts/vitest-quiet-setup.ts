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

// Every `--json` payload a test emits is checked against its contract, and the contract is recorded
// so a guard test can prove each one is exercised.
import { validationIssues } from "../packages/contracts/src/index.ts";

const emitted = ((globalThis as { __migentEmittedContracts?: Set<string> }).__migentEmittedContracts ??= new Set<string>());
cliHooks.validateJson = (schema, value) => {
  const issues = validationIssues(schema, value);
  if (issues.length > 0) {
    throw new Error(`JSON output violates ${String(schema.$id)}: ${JSON.stringify(issues.slice(0, 5))}`);
  }
  // Record the schema and, for a union, the variant this value matched.
  const shape = schema as { $id?: string; anyOf?: Array<{ $id?: string }> };
  if (typeof shape.$id === "string") emitted.add(shape.$id);
  for (const variant of shape.anyOf ?? []) {
    if (typeof variant.$id === "string" && validationIssues(variant as never, value).length === 0) emitted.add(variant.$id);
  }
};
