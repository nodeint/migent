import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LOCAL_CONFIG_FILE,
  configPath,
  hasLocalConfig,
  loadWorkspaceConfig,
  loadYamlMapping,
  stringifyConfig,
} from "@nodeint/migent-kernel";

/** The workspace-relative path of the machine-specific config. */
const LOCAL_LABEL = `.migent/${LOCAL_CONFIG_FILE}`;

/** Names of the models entries that `config.local.yaml` sets. */
function localModelNames(workspace: string): string[] {
  const local = loadYamlMapping(path.join(workspace, ".migent", LOCAL_CONFIG_FILE));
  const models = local.models;
  return typeof models === "object" && models !== null && !Array.isArray(models) ? Object.keys(models).sort() : [];
}

export function runConfigShow(workspace: string, options: { asJson?: boolean } = {}): number {
  const local = hasLocalConfig(workspace);
  if (options.asJson === true) {
    const payload = {
      config: loadWorkspaceConfig(workspace),
      local: local ? { file: LOCAL_LABEL, models: localModelNames(workspace) } : null,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (!local) {
    process.stdout.write(readFileSync(configPath(workspace), "utf8"));
    return 0;
  }
  process.stdout.write(stringifyConfig(loadWorkspaceConfig(workspace)));
  const names = localModelNames(workspace);
  const detail = names.length > 0 ? ` Local models: ${names.join(", ")}.` : "";
  process.stderr.write(`Merged with ${LOCAL_LABEL}.${detail}\n`);
  return 0;
}

/** The message a removed `config` editing subcommand prints. */
export function removedConfigCommand(name: string): string {
  return (
    `\`migent config ${name}\` was removed. Edit .migent/config.yaml (roles and model aliases) or ` +
    `${LOCAL_LABEL} (this machine's provider and model), then run \`migent doctor\`. ` +
    "`migent config` prints the effective config."
  );
}
