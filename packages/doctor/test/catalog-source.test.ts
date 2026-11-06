import { expect, test } from "vitest";
import { ClaudeCodeClient, ClaudeProvider } from "@nodeint/migent-adapters";
import { clientCatalogSource, loadCatalog, loadOptionValues } from "../src/catalog.ts";

const CATALOG = JSON.stringify({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "migent-models",
    response: {
      models: [
        { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
      ],
    },
  },
});

test("a client catalog source sends the client's own stdin and argv", async () => {
  const client = new ClaudeCodeClient();
  const source = clientCatalogSource(client);
  let seen: { argv: string[]; input?: string } | null = null;
  const catalog = await loadCatalog(source, () => "/bin/claude", (argv, input) => {
    seen = { argv, ...(input === undefined ? {} : { input }) };
    return CATALOG;
  });
  expect(catalog.ids).toContain("opus");
  expect(catalog.valuesFor("opus", "effort")).toEqual(["low", "high"]);
  expect(seen?.argv).toEqual(client.modelsCommand().argv);
  expect(seen?.input).toContain("migent-models");
});

test("a provider catalog source keeps the same behavior", async () => {
  const provider = new ClaudeProvider();
  const client = new ClaudeCodeClient();
  let providerInput: string | undefined;
  const catalog = await loadCatalog(provider, () => "/bin/claude", (argv) => {
    void argv;
    providerInput = provider.modelCatalogInput();
    return CATALOG;
  });
  expect(catalog.ids).toContain("opus");
  expect(providerInput).toBe(client.modelsCommand().stdin);
  expect(await loadOptionValues(provider, "effort", "opus", catalog, () => "/bin/claude", () => CATALOG)).toEqual([
    "low",
    "high",
  ]);
});
