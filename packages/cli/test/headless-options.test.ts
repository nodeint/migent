import { expect, test } from "vitest";
import { CodexProvider } from "@nodeint/migent-adapters";
import { collectProviders } from "../src/commands/provider.js";

test("headless discovery survives model lookup failure", async () => {
  const rows = await collectProviders({ codex: new CodexProvider() }, () => "/bin/codex", argv => {
    if (argv.includes("--help")) return "Options:\n  --model <MODEL>  Model to use\n";
    throw new Error("model service unavailable");
  });
  expect(rows[0].headless_options?.[0]).toMatchObject({ name: "model", valueMode: "required" });
  expect(rows[0].models).toEqual([]);
  expect(rows[0].problems).toContainEqual(expect.stringContaining("model service unavailable"));
});

test("unparseable help is reported without losing models", async () => {
  const rows = await collectProviders({ codex: new CodexProvider() }, () => "/bin/codex", argv => {
    if (argv.includes("--help")) return "unexpected output";
    return JSON.stringify({ models: [{ slug: "test-model", visibility: "list" }] });
  });
  expect(rows[0].headless_options).toBeNull();
  expect(rows[0].models).toEqual(["test-model"]);
  expect(rows[0].problems).toContainEqual(expect.stringContaining("Headless options:"));
});
