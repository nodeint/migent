import { existsSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    const tsUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(tsUrl)) return nextResolve(tsUrl.href, context);
  }
  return nextResolve(specifier, context);
}
