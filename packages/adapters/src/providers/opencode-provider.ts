import { ProviderBase } from "./provider-base.js";

export class OpencodeProvider extends ProviderBase {
  readonly displayName = "OpenCode";

  constructor(clientId: string = "opencode") {
    super(clientId);
  }
}
