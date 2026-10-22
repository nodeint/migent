import type { CliClient } from "@nodeint/migent-kernel";
import { ClientProvider } from "./client-provider.js";
import { AgyClient } from "../clients/agy-client.js";

export class AgyProvider extends ClientProvider {
  readonly displayName = "Antigravity";

  constructor(client: CliClient = new AgyClient()) {
    super(client);
  }
}
