import type { CliClient as ContractCliClient, CommandSpec } from '@nodeint/migent-contracts';

export type {
  BuildCommandInput,
  ClientOption,
  CliModelCatalog,
  CliRunOutput,
  CliUsage,
  CommandSpec,
  FailureClassification,
  FailureOrigin,
  InterruptOutcome,
  NativeOptionSupport,
  NewSession,
  ProviderClassification,
  QuotaClassification,
  RawFailure,
  ResponseSource,
  TurnUsage,
  UsageCapture,
} from '@nodeint/migent-contracts';

/**
 * The shared client contract plus the adapter-only discovery surface: `optionsCommand` and
 * `parseOptions` read a CLI's own help for the options it accepts.
 */
export interface CliClient extends ContractCliClient {
  optionsCommand(): CommandSpec;
  parseOptions(help: string): HeadlessOption[];
}

// ============ Constant và hàm từ kernel ============

export const KERNEL_PLACEHOLDER = 'kernel';

const CONTROL_PLANE_WARNING_MARKERS = ['failed to refresh available models'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function providerErrorMessage(payload: Record<string, unknown>): string | null {
  const {message} = payload;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const {error} = payload;
  if (isRecord(error)) {
    const nested = error.message;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  return null;
}

export function classifyProviderError(message: string | null): { event: string; summary: string } {
  let summary = typeof message === 'string' && message.trim() ? message.trim() : '';
  if (!summary) summary = 'provider emitted an error';
  const lowered = summary.toLowerCase();
  const event = CONTROL_PLANE_WARNING_MARKERS.some((marker) => lowered.includes(marker))
    ? 'provider.warning'
    : 'provider.error';
  return { event, summary };
}

/** Help-derived facts only. Unknown types must not be treated as boolean flags. */
export interface HeadlessOption {
  name: string;
  flags: string[];
  description: string;
  argument: string | null;
  valueMode: 'required' | 'optional' | 'none' | 'unknown';
  type: 'string' | 'number' | 'boolean' | 'array' | 'unknown';
  choices: string[] | null;
  defaultValue: string | null;
}
