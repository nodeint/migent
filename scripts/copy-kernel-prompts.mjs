import { cpSync } from "node:fs";

cpSync(new URL("../packages/kernel/prompts/", import.meta.url),
  new URL("../packages/kernel/dist/prompts/", import.meta.url), { recursive: true });
