import { cpSync } from "node:fs";

cpSync(new URL("../packages/prompts/prompts/", import.meta.url),
  new URL("../packages/prompts/dist/prompts/", import.meta.url), { recursive: true });
