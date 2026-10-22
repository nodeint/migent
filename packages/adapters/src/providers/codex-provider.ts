import type { CliClient } from "@nodeint/migent-kernel";
import { ClientProvider, moveThinkingTo, type Migration } from "./client-provider.js";
import { CODEX_REASONING_OPTION, CodexClient } from "../clients/codex-client.js";

const moveCodexThinking = moveThinkingTo(CODEX_REASONING_OPTION);

export class CodexProvider extends ClientProvider {
  readonly displayName = "Codex";
  readonly modelMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveCodexThinking };

  constructor(client: CliClient = new CodexClient()) {
    super(client);
  }
}
