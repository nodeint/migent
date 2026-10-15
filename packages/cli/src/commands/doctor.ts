import { diagnose, whichSync, type Check } from "@nodeint/migent-kernel";
import { printDoctor } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { adapterMap, type Which } from "../provider.js";

export async function runDoctor(
  workspace: string,
  options: { asJson?: boolean; which?: Which | null } = {},
): Promise<number> {
  requireCurrentSchema(workspace);
  const which = options.which ?? cliHooks.which ?? whichSync;
  const checks = diagnose(workspace, { adapters: adapterMap(), which });
  if (options.asJson) process.stdout.write(`${JSON.stringify(payload(checks))}\n`);
  else printDoctor(checks);
  return checks.every((check) => check.ok) ? 0 : 1;
}

function payload(checks: readonly Check[]): { ok: boolean; checks: Array<Record<string, unknown>> } {
  return {
    ok: checks.every((check) => check.ok),
    checks: checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      items: [...check.items],
      problems: [...check.problems],
    })),
  };
}
