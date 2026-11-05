import type { HeadlessOption } from "../types.js";

export interface HelpOptionsFormat {
  section: RegExp;
  /** False when help omits argument placeholders and types. */
  inferArgumentType: boolean;
}

/** Parse a help option table; the caller supplies its CLI's format. */
export function parseHelpOptions(help: string, format: HelpOptionsFormat): HeadlessOption[] {
  const lines = help.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const blocks: { header: string; description: string[] }[] = [];
  let active = false;
  for (const line of lines) {
    if (format.section.test(line)) { active = true; continue; }
    if (!active) continue;
    if (/^\S/.test(line) && line.trim()) { active = false; continue; }
    if (/^ {2,6}-{1,2}[A-Za-z]/.test(line)) {
      const parts = line.trim().split(/\s{2,}/);
      blocks.push({ header: parts[0], description: parts.slice(1) });
    } else if (line.trim() && blocks.length) {
      blocks[blocks.length - 1].description.push(line.trim());
    }
  }
  const options = blocks.map(({ header, description }): HeadlessOption => {
    const flags = header.match(/--?[A-Za-z][\w-]*/g) ?? [];
    const text = description.join(" ");
    const argument = header.match(/\[<[^>]+>\]|<[^>]+>|\[[^\]]+\]/)?.[0] ?? null;
    const explicitType = text.match(/\[(string|number|boolean|array)\]/)?.[1] as HeadlessOption["type"] | undefined;
    const type = explicitType ?? (!format.inferArgumentType ? "unknown" : argument ? "string" : "boolean");
    const choice = text.match(/\[(?:possible values|choices):\s*([^\]]+)\]/)
      ?? text.match(/\(choices:\s*([^\)]+)\)/);
    const choices = choice ? choice[1].split(",").map(value => value.trim().replace(/^"|"$/g, "")) : null;
    return {
      name: (flags.find(flag => flag.startsWith("--")) ?? flags[0] ?? "").replace(/^-+/, ""),
      flags, description: text, argument,
      valueMode: !format.inferArgumentType ? "unknown" : argument ? argument.startsWith("[") ? "optional" : "required" : explicitType && explicitType !== "boolean" ? "required" : "none",
      type, choices,
      defaultValue: text.match(/\[default:\s*(\[\]|[^\]]*)\]/)?.[1] ?? text.match(/\(default ([^)]*)\)/)?.[1] ?? null,
    };
  });
  if (!options.length) throw new Error("No headless options found in help.");
  return options;
}

