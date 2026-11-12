import type { HeadlessOption } from '../types.js';

export interface HelpOptionsFormat {
  section: RegExp;
  /** False when help omits argument placeholders and types. */
  inferArgumentType: boolean;
  /** Markers after which the description lists long-flag aliases, for example `[aliases: --effort]`. */
  aliasMarkers?: readonly RegExp[];
}

const ESC = '\u001B';

/** Parse a help option table; the caller supplies its CLI's format. */
export function parseHelpOptions(help: string, format: HelpOptionsFormat): HeadlessOption[] {
  const lines = help.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').split(/\r?\n/);
  const blocks: { header: string; description: string[] }[] = [];
  let active = false;
  for (const line of lines) {
    if (format.section.test(line)) { active = true; continue; }
    if (!active) continue;
    if (/^\S/.test(line) && line.trim()) { active = false; continue; }
    if (/^ {2,6}-{1,2}[A-Za-z]/.test(line)) {
      const parts = line.trim().split(/\s{2,}/);
      blocks.push({ header: parts[0], description: parts.slice(1) });
    } else if (line.trim() && blocks.length > 0) {
      blocks[blocks.length - 1].description.push(line.trim());
    }
  }
  const options = blocks.map(({ header, description }): HeadlessOption => {
    const text = description.join(' ');
    const flags = [...new Set([...(header.match(/--?[A-Za-z][\w-]*/g) ?? []), ...descriptionAliases(text, format)])];
    const argument = header.match(/\[<[^>]+>\]|<[^>]+>|\[[^\]]+\]/)?.[0] ?? null;
    const explicitType = text.match(/\[(string|number|boolean|array)\]/)?.[1] as HeadlessOption['type'] | undefined;
    const type = explicitType ?? inferredType(format.inferArgumentType, argument);
    const choice = text.match(/\[(?:possible values|choices):\s*([^\]]+)\]/)
      ?? text.match(/\(choices:\s*([^)]+)\)/);
    const choices = choice ? choice[1].split(',').map(unquoteChoice) : null;
    return {
      name: optionName(flags),
      flags, description: text, argument,
      valueMode: valueModeOf(format.inferArgumentType, argument, explicitType),
      type, choices,
      defaultValue: text.match(/\[default:\s*(\[\]|[^\]]*)\]/)?.[1] ?? text.match(/\(default ([^)]*)\)/)?.[1] ?? null,
    };
  });
  if (options.length === 0) throw new Error('No headless options found in help.');
  return options;
}

function inferredType(infer: boolean | undefined, argument: string | null): HeadlessOption['type'] {
  if (!infer) return 'unknown';
  return argument ? 'string' : 'boolean';
}

function valueModeOf(
  infer: boolean | undefined,
  argument: string | null,
  explicitType: HeadlessOption['type'] | undefined,
): HeadlessOption['valueMode'] {
  if (!infer) return 'unknown';
  if (argument) return argument.startsWith('[') ? 'optional' : 'required';
  return explicitType && explicitType !== 'boolean' ? 'required' : 'none';
}

function unquoteChoice(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

/** The long flag without dashes, else the first flag. */
function optionName(flags: readonly string[]): string {
  return (flags.find(isLongFlag) ?? flags[0] ?? '').replace(/^-+/, '');
}

function isLongFlag(flag: string): boolean {
  return flag.startsWith('--');
}

/** Long flags the description declares as aliases, in the client's own marker format. */
function descriptionAliases(text: string, format: HelpOptionsFormat): string[] {
  const found: string[] = [];
  for (const marker of format.aliasMarkers ?? []) {
    const match = marker.exec(text);
    if (match?.[1] !== undefined) found.push(...(match[1].match(/--[A-Za-z][\w-]*/g) ?? []));
  }
  return found;
}
