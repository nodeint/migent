import type { CliClient } from "@nodeint/migent-kernel";
import { ClientProvider } from "./client-provider.js";
import { OpencodeClient } from "../clients/opencode-client.js";

export class OpencodeProvider extends ClientProvider {
  readonly displayName = "OpenCode";

  constructor(client: CliClient = new OpencodeClient()) {
    super(client);
  }
}
