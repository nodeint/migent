import { readFileSync } from "node:fs";
import {
  LOCAL_CONFIG_LABEL as LOCAL_LABEL,
  configPath,
  hasLocalConfig,
  loadWorkspaceConfig,
  localAgentNames,
  stringifyConfig,
} from "@nodeint/migent-kernel";

export function runConfigShow(workspace: string, options: { asJson?: boolean } = {}): number {
  const local = hasLocalConfig(workspace);
  if (options.asJson === true) {
    const payload = {
      config: loadWorkspaceConfig(workspace),
      local: local ? { file: LOCAL_LABEL, agents: localAgentNames(workspace) } : null,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (!local) {
    process.stdout.write(readFileSync(configPath(workspace), "utf8"));
    return 0;
  }
  process.stdout.write(stringifyConfig(loadWorkspaceConfig(workspace)));
  const names = localAgentNames(workspace);
  const detail = names.length > 0 ? ` Local agents: ${names.join(", ")}.` : "";
  process.stderr.write(`Merged with ${LOCAL_LABEL}.${detail}\n`);
  return 0;
}

/** The message a removed `config` editing subcommand prints. */
export function removedConfigCommand(name: string): string {
  return (
    `\`migent config ${name}\` was removed. Edit .migent/config.yaml (roles and agents) or ` +
    `${LOCAL_LABEL} (this machine's provider and model), then run \`migent doctor\`. ` +
    "`migent config` prints the effective config."
  );
}
