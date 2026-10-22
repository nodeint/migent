import { ProviderBase, moveThinkingTo, type Migration } from "./client-provider.js";
import { CODEX_REASONING_OPTION } from "../clients/codex-client.js";

const moveCodexThinking = moveThinkingTo(CODEX_REASONING_OPTION);

export class CodexProvider extends ProviderBase {
  readonly displayName = "Codex";
  readonly modelMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveCodexThinking };

  constructor(clientId: string = "codex") {
    super(clientId);
  }
}
