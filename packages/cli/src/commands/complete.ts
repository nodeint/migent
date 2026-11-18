import path from 'node:path';

import { CompleteResult } from '@nodeint/migent-contracts';
import { completeSessionManually } from '@nodeint/migent-engine';
import { ConfigurationError, log } from '@nodeint/migent-kernel';
import { formatNextCommand, isSessionLockLost, SessionLockHeldError } from '@nodeint/migent-session';

import { clientRegistry, pluginRegistry } from '../client.js';
import { printError } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CONFIG } from '../exits.js';
import { cliHooks } from '../hooks.js';
import { requireCurrentSchema } from '../migrate.js';

function outputPaths(directory: string, outputs: Record<string, unknown>): { name: string; path: string }[] {
  return Object.entries(outputs).map(([name, value]) => {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const relative = typeof record.path === 'string' && record.path !== '' ? record.path : path.join('outputs', name);
    return { name, path: path.resolve(directory, relative) };
  });
}

/** Mark a stopped workflow session completed. Exit 2 when the session cannot be completed. */
export async function completeSession(workspace: string, sessionId: string, asJson: boolean): Promise<number> {
  requireCurrentSchema(workspace);
  let result;
  try {
    const outcome = await completeSessionManually(workspace, sessionId, {
      pluginRegistry: cliHooks.runner?.pluginRegistry ?? pluginRegistry(), clients: clientRegistry(),
    });
    ({ result } = outcome);
    if (outcome.pluginWarning !== null) log(`warning: plugins not run: ${outcome.pluginWarning}`);
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof SessionLockHeldError || isSessionLockLost(error)) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    throw error;
  }
  const outputs = outputPaths(path.resolve(workspace, '.migent', 'sessions', sessionId), result.outputs);
  if (asJson) {
    writeJson(CompleteResult, {
      session_id: sessionId,
      status: 'completed',
      already_completed: result.alreadyCompleted,
      outputs,
      missing_outputs: result.missingOutputs,
      next: {
        path: result.next.path,
        suggestions: result.next.next.map((suggestion) => ({
          ...suggestion,
          command: formatNextCommand(suggestion.argv),
        })),
      },
    });
    return 0;
  }
  log(result.alreadyCompleted ? `Session ${sessionId} is already completed.` : `Session ${sessionId} completed manually.`);
  for (const name of result.missingOutputs) log(`warning: required artifact missing: ${name}`);
  for (const output of outputs) log(`artifact: ${output.path}`);
  if (result.next.path) log(`next: ${result.next.path}`);
  for (const suggestion of result.next.next) log(formatNextCommand(suggestion.argv));
  return 0;
}
