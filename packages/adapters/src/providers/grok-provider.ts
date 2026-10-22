import { ProviderBase, moveThinkingTo, type Migration } from "./provider-base.js";
import { GROK_REASONING_OPTION } from "../clients/grok-client.js";

const moveGrokThinking = moveThinkingTo(GROK_REASONING_OPTION);

export class GrokProvider extends ProviderBase {
  readonly displayName = "Grok";
  readonly modelMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveGrokThinking };

  constructor(clientId: string = "grok") {
    super(clientId);
  }
}
