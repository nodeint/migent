import type { ClientOption, NativeOptionSupport } from '../types.js';

/**
 * What help cannot express about a client's native options. The set of valid options is the
 * installed CLI's own help; this overlay holds only the flags Migent controls, renamed keys and
 * the prompt/overridable policy rows.
 */
export interface NativeOptionOverlay {
  /** The client's name in messages, for example `claude`. */
  label: string;
  /** Long flags (with `--`, aliases included) that Migent emits itself or that break the headless protocol. */
  reserved: readonly string[];
  /** Config keys whose flag does not follow the key mapping, with the other spellings of that flag. */
  renames?: Readonly<Record<string, { flag: string; aliases?: readonly string[] }>>;
  /** The only rows `options()` reports: effort and other prompt/overridable options. */
  policy: readonly ClientOption[];
}

const CANONICAL_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function flagOfKey(key: string): string {
  return `--${key.replaceAll('_', '-')}`;
}

/** Builds the offline validation, key mapping and argv encoding for one overlay. */
export class NativeOptions implements NativeOptionSupport {
  private readonly reserved: ReadonlySet<string>;
  private readonly owner = new Map<string, string>();
  private readonly renamed = new Map<string, string>();

  public readonly reservedFlags: readonly string[];

  constructor(private readonly overlay: NativeOptionOverlay) {
    this.reserved = new Set(overlay.reserved);
    for (const [key, { flag, aliases = [] }] of Object.entries(overlay.renames ?? {})) {
      this.renamed.set(key, flag);
      for (const spelling of [flag, ...aliases]) this.owner.set(spelling, key);
    }
    this.reservedFlags = [...overlay.reserved];
  }

  /** The reason a key cannot be used, or null. */
  public problem(key: string): string | null {
    if (this.renamed.has(key)) return null;
    if (!CANONICAL_KEY.test(key)) {
      return `${key} is not a ${this.overlay.label} option key: use lowercase snake case such as ${canonicalOf(key)}.`;
    }
    const flag = flagOfKey(key);
    const owner = this.owner.get(flag);
    if (owner !== undefined) return `${key} reaches ${flag}, which is set by ${owner}: use ${owner}.`;
    if (this.reserved.has(flag)) return `${key} (${flag}) is set by Migent and cannot be changed through ${this.overlay.label} options.`;
    return null;
  }

  public flagFor(key: string): string | null {
    const renamed = this.renamed.get(key);
    if (renamed !== undefined) return renamed;
    return this.problem(key) === null ? flagOfKey(key) : null;
  }

  /** Structural checks only: key syntax, reserved flags, blank values. Never reads help. */
  public validate(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const problem = this.problem(key);
      if (problem !== null) throw new Error(problem);
      if (value.trim() === '') throw new Error(`${key} is empty.`);
    }
  }

  /** `true` is the bare flag, `false` emits nothing, anything else is `--flag value`. */
  public append(argv: string[], options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const flag = this.flagFor(key);
      if (flag === null || value === 'false') continue;
      argv.push(flag);
      if (value !== 'true') argv.push(value);
    }
  }

  public rows(): readonly ClientOption[] {
    return this.overlay.policy;
  }
}

function canonicalOf(key: string): string {
  const snake = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return snake.replace(/^_+|_+$/g, '') || 'option_name';
}
