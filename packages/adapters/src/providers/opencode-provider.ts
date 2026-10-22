import { ProviderBase } from "./client-provider.js";

export class OpencodeProvider extends ProviderBase {
  readonly displayName = "OpenCode";

  constructor(clientId: string = "opencode") {
    super(clientId);
  }
}
