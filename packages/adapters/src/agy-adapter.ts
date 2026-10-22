import type { CliClient } from "@nodeint/migent-kernel";
import { ClientAdapter } from "./client-adapter.js";
import { AgyClient } from "./clients/agy-client.js";

export class AgyAdapter extends ClientAdapter {
  readonly displayName = "Antigravity";

  constructor(client: CliClient = new AgyClient()) {
    super(client);
  }
}
