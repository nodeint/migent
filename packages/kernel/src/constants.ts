/** Generic units and conventions shared across Migent packages (owned here; see the kernel barrel). */

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;

/** Indent for `JSON.stringify(value, null, JSON_INDENT)` and the default YAML nesting unit. */
export const JSON_INDENT = 2;
/** Width of a zero-padded clock or counter field (`HH`, `MM`, `SS`, `01.log`). */
export const PAD_WIDTH_2 = 2;
/** Width of a zero-padded four-digit field (years, sequence numbers). */
export const PAD_WIDTH_4 = 4;
/** `process.argv` entries before user arguments (`node`, script). */
export const ARGV_USER_OFFSET = 2;
/** Radix for hexadecimal text. */
export const HEX_RADIX = 16;
/** Bytes of one Int32 cell in a `SharedArrayBuffer` used for `Atomics.wait` sleeps. */
export const INT32_BYTES = 4;

/** The line-feed byte. */
export const NEWLINE_BYTE = 0x0a;

/** Shells report a signal death as `128 + signal`. */
export const SHELL_SIGNAL_BASE = 128;
/** Highest signal number (above the base) still treated as a signal exit. */
export const SHELL_SIGNAL_RANGE = 64;
/** Shell exit status for "command not found / cannot start". */
export const EXIT_COMMAND_NOT_FOUND = 127;
/** True for a shell-style signal exit status (`128 < code <= 128 + 64`). Callers add their own context checks. */
export function isShellSignalExitCode(code: number): boolean {
  return code > SHELL_SIGNAL_BASE && code <= SHELL_SIGNAL_BASE + SHELL_SIGNAL_RANGE;
}

/** Default nesting unit when a YAML document gives no indentation to learn from. */
export const YAML_DEFAULT_INDENT = 2;
/** Length of a matching quote pair around a scalar. */
export const QUOTE_PAIR_LENGTH = 2;
/** Length of the `- ` list marker. */
export const LIST_MARKER_LENGTH = 2;
/** Random bytes in a temp-file name suffix. */
export const TEMP_SUFFIX_BYTES = 6;
/** Random bytes in a wrapper endpoint token. */
export const ENDPOINT_TOKEN_BYTES = 16;
/** Poll interval while waiting for a terminating process group. */
export const TERMINATION_POLL_MS = 50;
/** First numeric suffix for a duplicate name (`agent-2`). */
export const FIRST_DUPLICATE_SUFFIX = 2;
/** Option letters start at `A`. */
export const OPTION_LETTER_BASE = 65;
/** Maximum options per question (`A`..`Z`). */
export const MAX_QUESTION_OPTIONS = 26;
/** Minimum options per question. */
export const MIN_QUESTION_OPTIONS = 2;
/** Grace added to a probe worker's wait beyond its own socket timeout. */
export const PROBE_SLACK_MS = 1000;
/** Poll interval of the wrapper's group-termination loop. */
export const WRAPPER_POLL_MS = 50;
/** Delay before a signal-death exit falls back when the owner does not answer. */
export const SIGNAL_REPORT_FALLBACK_MS = 500;
/** Exit status of a wrapper that failed on an unpassable argument. */
export const EXIT_UNPASSABLE_ARGUMENT = 2;
/** Exit status of a generic wrapper failure. */
export const EXIT_WRAPPER_FAILURE = 1;
/** Index of the `agent` key in a `roles.<role>.agent` config path. */
export const ROLE_AGENT_KEY_INDEX = 2;
/** ASCII whitespace bytes (the set `String.prototype.trim` agrees on for ASCII). */
export const TAB_BYTE = 0x09;
export const VERTICAL_TAB_BYTE = 0x0b;
export const FORM_FEED_BYTE = 0x0c;
export const CARRIAGE_RETURN_BYTE = 0x0d;
export const SPACE_BYTE = 0x20;
/** Byte-size units. */
export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
/** Config schema version that still holds legacy provider/client keys; migration lifts clients from it. */
export const CONFIG_CLIENTS_LIFT_FROM = 5;
/** Indent levels between a block's key and its nested entries (`key:` -> `child:` -> `value`). */
export const NESTED_INDENT_LEVELS = 2;
