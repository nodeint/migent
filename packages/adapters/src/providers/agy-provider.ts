import { ProviderBase } from "./client-provider.js";

export class AgyProvider extends ProviderBase {
  readonly displayName = "Antigravity";

  constructor(clientId: string = "agy") {
    super(clientId);
  }
}
