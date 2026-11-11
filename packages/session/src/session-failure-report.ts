import { existsSync } from 'node:fs';
import path from 'node:path';

import { legacyClientOf, renderProviderDiagnostics, VERIFY_EXHAUSTED, VERIFY_FAILED, writeFileAtomic } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { DIAGNOSTICS_FILENAME, type ExecutionContext,FAILURE_FILENAME } from './session-store-types.js';
import { readJsonObject, textField } from './session-store-util.js';

/**
 * A readable report beside a failed execution. It keeps errors out of response.md,
 * which holds only what the provider returned.
 */
export function writeFailureReport(
  context: ExecutionContext,
  metadata: Record<string, unknown>,
  error: string | null,
): void {
  const stageId = textField(metadata.stage_id) ?? 'agent';
  const attempt = typeof metadata.stage_attempt === 'number' ? metadata.stage_attempt : null;
  const client = textField(metadata.client) ?? legacyClientOf(textField(metadata.provider));
  const model = textField(metadata.model);
  const failureReason = textField(metadata.failure_reason);
  const lines = [
    '# Execution failed',
    '',
    `- Session: \`${context.sessionId}\``,
    `- Execution: \`${context.executionId}\``,
    `- Stage: \`${stageId}\`${attempt === null ? '' : ` (attempt ${attempt})`}`,
  ];
  if (metadata.kind === 'verify') lines.push('- Kind: verify-only');
  if (client !== null || model !== null) {
    lines.push(`- Client: \`${client ?? 'unknown'}/${model ?? 'unknown'}\``);
  }
  if (failureReason !== null) lines.push(`- Failure reason: \`${failureReason}\``);
  if (failureReason === 'quota') {
    const resetAt = textField(metadata.retry_at);
    const window = textField(metadata.quota_window);
    if (resetAt !== null) lines.push(`- Quota resets at: ${resetAt}`);
    if (window !== null) lines.push(`- Quota window: \`${window}\``);
  }
  if (typeof metadata.completed_at === 'string') lines.push(`- Completed at: ${metadata.completed_at}`);
  lines.push('', '## Error', '', '```text', error === null ? 'No error message was recorded.' : error, '```');
  const diagnostics = readDiagnostics(context.directory);
  if (diagnostics !== null) {
    lines.push(
      '',
      ...renderProviderDiagnostics({
        diagnostics,
        finalTurn: typeof metadata.final_turn === 'number' ? metadata.final_turn : null,
        failureReason,
        link: DIAGNOSTICS_FILENAME,
      }),
    );
  } else if (existsSync(path.join(context.directory, DIAGNOSTICS_FILENAME))) {
    lines.push('', '## Diagnostics', '', `See [\`${DIAGNOSTICS_FILENAME}\`](${DIAGNOSTICS_FILENAME}).`);
  }
  const verifyReport = verifyFailureReport(context.directory, metadata, failureReason);
  if (verifyReport !== null) {
    lines.push('', '## Verify', '', `See [\`${verifyReport}\`](${verifyReport}).`);
  }
  writeFileAtomic(path.join(context.directory, FAILURE_FILENAME), `${lines.join('\n')}\n`);
}

function readDiagnostics(directory: string): Record<string, unknown> | null {
  try {
    return readJsonObject(path.join(directory, DIAGNOSTICS_FILENAME));
  } catch {
    return null;
  }
}

export function verifyFailureReport(
  directory: string,
  metadata: Record<string, unknown>,
  failureReason: string | null,
): string | null {
  const verify = isRecord(metadata.verify) ? metadata.verify : null;
  const recorded =
    verify !== null && typeof verify.last_report === 'string' && verify.last_report !== ''
      ? verify.last_report
      : null;
  if (recorded !== null) return existsSync(path.join(directory, recorded)) ? recorded : null;
  if (failureReason !== VERIFY_EXHAUSTED && failureReason !== VERIFY_FAILED) return null;
  return existsSync(path.join(directory, 'turns/01/verify.md')) ? 'turns/01/verify.md' : null;
}
