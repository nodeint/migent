import type { CliClient } from "@nodeint/migent-kernel";
import { ClientAdapter } from "./client-adapter.js";
import { OpencodeClient } from "./clients/opencode-client.js";

export class OpencodeAdapter extends ClientAdapter {
  readonly displayName = "OpenCode";

  constructor(client: CliClient = new OpencodeClient()) {
    super(client);
  }
}
