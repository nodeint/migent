import path from "node:path";
import type { Check } from "@nodeint/migent-kernel";
import { skillSourceDirectory } from "./commands/skill.js";
import { scanInstalledSkills } from "./skill-scan.js";

/** Reports installed copies of the Migent skill. Only ever warns. */
export function skillCheck(workspace: string, home: string): Check {
  const check: Check = { name: "skill", ok: true, items: [], problems: [], warnings: [] };
  const installed = scanInstalledSkills({ workspace, home }, skillSourceDirectory());
  if (installed.length === 0) {
    check.warnings.push("Migent skill is not installed; run `migent skill install`.");
    return check;
  }
  for (const entry of installed) {
    const shown = entry.scope === "global" ? `~/${relative(home, entry.directory)}` : relative(workspace, entry.directory);
    check.items.push(`${shown} (${entry.clients.join(", ")}) ${entry.state}`);
    if (entry.state === "different") {
      check.warnings.push(
        `${shown} differs from the skill bundled with this CLI; run \`migent skill update${entry.scope === "global" ? " --global" : ""}\`.`,
      );
    }
  }
  return check;
}

function relative(base: string, target: string): string {
  return path.relative(base, target).split(path.sep).join("/");
}
