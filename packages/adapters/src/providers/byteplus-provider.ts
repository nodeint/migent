import { ProviderBase } from "./provider-base.js";

/**
 * BytePlus ModelArk models run through another vendor's CLI, so there is no
 * default client: each model must name one with `models.<name>.client`.
 * Doctor reports a missing client; running without one throws.
 */
export class ByteplusProvider extends ProviderBase {
  readonly displayName = "BytePlus";

  constructor(clientId: string | null = null) {
    super(clientId);
  }

  override get command(): string {
    return this.requiresClient ? "byteplus" : super.command;
  }
}
