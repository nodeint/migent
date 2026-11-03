import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

// Source tests read the source assets; published modules read only packaged assets.
const directory = new URL(import.meta.url.endsWith(".ts") ? "../prompts/" : "./prompts/", import.meta.url);
const engine = Handlebars.create();
for (const name of ["task", "continuation", "response-contract", "artifact"]) {
  engine.registerPartial(name, readFileSync(new URL(`${name}.md.hbs`, directory), "utf8").replace(/\r\n/g, "\n"));
}
const templates = new Map<string, ReturnType<typeof engine.compile>>();

type PromptName = "stage-start" | "stage-continue" | "stage-reply" | "verify-repair"
  | "role-run" | "provider-turn" | "history" | "question-correction" | "protocol-update";

/** Internal: renders one template by name. Strict lookup fails on missing data. */
export function renderPrompt(name: PromptName, context: object): string {
  let template = templates.get(name);
  if (!template) {
    const source = readFileSync(new URL(`${name}.md.hbs`, directory), "utf8").replace(/\r\n/g, "\n");
    template = engine.compile(source, { strict: true, noEscape: true, preventIndent: true, ignoreStandalone: true });
    templates.set(name, template);
  }
  return template(context);
}
