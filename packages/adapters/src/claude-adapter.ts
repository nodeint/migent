import { randomUUID } from "node:crypto";
import type { BuildCommandInput, CliClient, NewSession } from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ClientAdapter } from "./client-adapter.js";
import { ClaudeCodeClient } from "./clients/claude-code-client.js";

const DEFAULT_PERMISSION_MODE = "bypassPermissions";

export class ClaudeAdapter extends ClientAdapter {
  readonly displayName = "Claude";

  constructor(client: CliClient = new ClaudeCodeClient()) {
    super(client);
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
