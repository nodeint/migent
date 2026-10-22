import { randomUUID } from "node:crypto";
import type { BuildCommandInput, NewSession } from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ProviderBase } from "./client-provider.js";

const DEFAULT_PERMISSION_MODE = "bypassPermissions";

export class ClaudeProvider extends ProviderBase {
  readonly displayName = "Claude";

  constructor(clientId: string = "claude-code") {
    super(clientId);
  }

  createNewSession(): NewSession {
    return { agentId: randomUUID() };
  }

  modelCatalogInput(): string {
    return this.client.modelsCommand().stdin ?? "";
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    const options = { ...input.options };
    if (options.permission_mode === undefined) options.permission_mode = DEFAULT_PERMISSION_MODE;
    return super.buildCommand({ ...input, options });
  }
}
