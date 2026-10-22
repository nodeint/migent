import { ProviderBase } from "./provider-base.js";

export class AgyProvider extends ProviderBase {
  readonly displayName = "Antigravity";

  constructor(clientId: string = "agy") {
    super(clientId);
  }
}
