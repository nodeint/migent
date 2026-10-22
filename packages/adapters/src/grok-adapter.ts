import type { CliClient } from "@nodeint/migent-kernel";
import { ClientAdapter, moveThinkingTo, type Migration } from "./client-adapter.js";
import { GROK_REASONING_OPTION, GrokClient } from "./clients/grok-client.js";

const moveGrokThinking = moveThinkingTo(GROK_REASONING_OPTION);

export class GrokAdapter extends ClientAdapter {
  readonly displayName = "Grok";
  readonly modelMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveGrokThinking };

  constructor(client: CliClient = new GrokClient()) {
    super(client);
  }
}
