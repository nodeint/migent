import type { CliClient, InterruptOutcome } from './cli-client.js';
import { killProcessTree } from './process-wrapper.js';
import { spawnProvider } from './provider-spawn.js';

/** Bounds for one explicit server-side interrupt. The whole cleanup stays within a few seconds. */
export interface InterruptPolicy {
  /** Tries while the server still answers "not found": the session may not exist yet. */
  attempts: number;
  retryDelayMs: number;
  /** One interrupt command is killed after this long. */
  commandTimeoutMs: number;
}

export const DEFAULT_INTERRUPT_POLICY: InterruptPolicy = {
  attempts: 4,
  retryDelayMs: 400,
  commandTimeoutMs: 8000,
};

export interface InterruptReport {
  agentId: string;
  outcome: InterruptOutcome;
  attempts: number;
  detail: string;
}

const OUTPUT_LIMIT = 16_384;

interface CommandRun {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

/** Runs one cleanup command. It never consults the cancellation flag: it must finish after a cancel. */
function runCleanupCommand(argv: readonly string[], cwd: string, timeoutMs: number): Promise<CommandRun> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (run: Omit<CommandRun, 'output' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...run, output, timedOut });
    };
    let child;
    try {
      child = spawnProvider(argv[0] ?? '', argv.slice(1), {
        cwd,
        // POSIX: its own process group, so a timeout can signal the whole tree. Windows uses taskkill /T.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ exitCode: null, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    const collect = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => finish({ exitCode: null, spawnError: error.message }));
    child.once('close', (code) => finish({ exitCode: code, spawnError: null }));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) killProcessTree(child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      // Pipes held by a surviving grandchild must not keep Migent alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ exitCode: null, spawnError: null });
    }, timeoutMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks the provider to stop the server-side turn of `agentId`. Returns null when the provider
 * has no such command. `not-found` is retried within the policy's bounds, because the server may
 * not have created the session yet; a final `not-found` is not proof that no turn will start.
 */
export async function interruptSession(
  provider: CliClient,
  agentId: string,
  cwd: string,
  policy: InterruptPolicy = DEFAULT_INTERRUPT_POLICY,
): Promise<InterruptReport | null> {
  const spec = provider.interruptCommand?.(agentId) ?? null;
  if (spec === null) return null;
  let outcome: InterruptOutcome = 'failed';
  let detail = '';
  let attempts = 0;
  while (attempts < Math.max(1, policy.attempts)) {
    if (attempts > 0) await sleep(policy.retryDelayMs);
    attempts += 1;
    const run = await runCleanupCommand(spec.argv, cwd, policy.commandTimeoutMs);
    if (run.spawnError !== null) {
      outcome = 'failed';
      detail = `could not run the interrupt command: ${run.spawnError}`;
      break;
    }
    if (run.timedOut) {
      outcome = 'failed';
      detail = `the interrupt command did not finish within ${policy.commandTimeoutMs}ms`;
      break;
    }
    outcome = provider.classifyInterrupt?.(run.output, run.exitCode) ?? 'failed';
    detail = outcome === 'failed' ? `interrupt exited with code ${run.exitCode ?? 'null'}` : outcome;
    if (outcome !== 'not-found') break;
  }
  return { agentId, outcome, attempts, detail };
}

/** True when the report shows the server holds no running turn for the session. */
export function isSettled(report: InterruptReport | undefined): boolean {
  return report !== undefined && (report.outcome === 'interrupted' || report.outcome === 'idle');
}
