/** Actions behind `session run` and `session continue`: mode split, reply input, and dispatch. */
import { readFileSync } from 'node:fs';

import type { OptionValues } from 'commander';

import { printError } from '../display.js';
import { EXIT_CONFIG } from '../exits.js';
import { optionalText, rawText, stringList } from '../text.js';
import { findWorkspace, invocationCwdPath } from '../workspace.js';
import { continueRoleSession, isAgentSession, runAgent } from './agent.js';
import { dispatchCeiling, executeWorkflow, rejectOnce, runWorkflowCommand } from './execute.js';

const RUN_SPLIT = 'Pass --workflow for a workflow run, or --role for an agent run.';

export function runSessionCommand(options: OptionValues): number | Promise<number> {
  if (options.stage !== undefined && optionalText(options.stage) === null) {
    printError('--stage is empty.');
    return EXIT_CONFIG;
  }
  const workflowProvided = options.workflow !== undefined;
  const workflowId = optionalText(options.workflow);
  if (workflowProvided && workflowId === null) {
    printError('--workflow is empty.');
    return EXIT_CONFIG;
  }
  const sessionId = optionalText(options.session);
  const roleMode = roleFlagsPresent(options);
  if (mixedModes(options, { workflowId, sessionId, roleMode })) {
    printError(RUN_SPLIT);
    return EXIT_CONFIG;
  }
  // A session without role flags is a prepared workflow session; it records its own workflow.
  if (workflowId !== null || (sessionId !== null && !roleMode)) return runWorkflowMode(options, workflowId, sessionId);
  if (!roleMode) {
    printError(RUN_SPLIT);
    return EXIT_CONFIG;
  }
  return runAgent(options, optionalText(options.session));
}

function mixedModes(
  options: OptionValues,
  state: { workflowId: string | null; sessionId: string | null; roleMode: boolean },
): boolean {
  const { workflowId, sessionId, roleMode } = state;
  if (workflowId !== null) return roleMode;
  return workflowFlagsPresent(options) && (roleMode || sessionId === null);
}

function runWorkflowMode(
  options: OptionValues,
  workflowId: string | null,
  sessionId: string | null,
): number | Promise<number> {
  const task = rawText(options.task);
  const prepared = sessionId !== null;
  if (prepared && task !== null) {
    printError('Pass --workflow and --task, or --session, not both.');
    return EXIT_CONFIG;
  }
  if (!prepared && task === null && options.prior === undefined) {
    printError('Pass --task.');
    return EXIT_CONFIG;
  }
  return runWorkflowCommand({
    workflowId,
    task,
    sessionId,
    prepared,
    once: options.once === true,
    options,
    output: outputFlags(options),
  });
}

function roleFlagsPresent(options: OptionValues): boolean {
  return (
    options.role !== undefined ||
    options.client !== undefined ||
    options.provider !== undefined ||
    options.model !== undefined ||
    stringList(options.option).length > 0 ||
    options.prompt !== undefined ||
    options.file !== undefined ||
    options.stdin === true ||
    options.json === true
  );
}

function workflowFlagsPresent(options: OptionValues): boolean {
  return (
    options.once === true ||
    options.stage !== undefined ||
    options.prior !== undefined ||
    options.maxDispatches !== undefined ||
    options.unlimitedDispatches === true ||
    options.progress === true ||
    options.verbose === true ||
    options.refreshWorkflow === true ||
    options.skipPreflight === true
  );
}

export function continueSession(session: string, options: OptionValues): number | Promise<number> {
  if (options.stage !== undefined && optionalText(options.stage) === null) {
    printError('--stage is empty.');
    return EXIT_CONFIG;
  }
  const workspace = findWorkspace(invocationCwdPath());
  if (isAgentSession(workspace, session)) return continueRoleSession(
    { workspace, sessionId: session },
    options,
    readReply,
  );
  if (rejectOnce(options)) return EXIT_CONFIG;
  const reply = readReply(options);
  if (reply === 'invalid') return EXIT_CONFIG;
  const stageId = optionalText(options.stage);
  // With --reply and no --once, --stage only picks the stage that receives the reply; the workflow keeps running.
  if (options.once === true || (stageId !== null && reply === null)) {
    return executeWorkflow(findWorkspace(invocationCwdPath()), {
      action: 'stage',
      sessionId: session,
      stageId,
      priorSessionId: optionalText(options.prior),
      maxDispatches: null,
      continueFailed: true,
      refreshWorkflow: options.refreshWorkflow === true,
      reply,
      ...outputFlags(options),
    });
  }
  const ceiling = dispatchCeiling(options);
  if (typeof ceiling === 'string') return EXIT_CONFIG;
  return executeWorkflow(findWorkspace(invocationCwdPath()), {
    action: 'continue',
    sessionId: session,
    replyStageId: stageId,
    priorSessionId: optionalText(options.prior),
    maxDispatches: ceiling,
    continueFailed: true,
    refreshWorkflow: options.refreshWorkflow === true,
    reply,
    ...outputFlags(options),
  });
}

function readReply(options: OptionValues): string | null | 'invalid' {
  const hasReply = options.reply !== undefined;
  const hasFile = options.replyFile !== undefined;
  if (!hasReply && !hasFile) return null;
  if (hasReply && hasFile) {
    printError('Pass only one of --reply or --reply-file.');
    return 'invalid';
  }
  if (hasFile) return readReplyFile(options);
  const reply = rawText(options.reply);
  if (reply === null || reply.trim() === '') {
    printError('--reply is empty.');
    return 'invalid';
  }
  return reply;
}

function readReplyFile(options: OptionValues): string | 'invalid' {
  const file = optionalText(options.replyFile);
  if (file === null) {
    printError('--reply-file is empty.');
    return 'invalid';
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    printError(`Unable to read reply file: ${file} (${reason})`);
    return 'invalid';
  }
  if (text.trim() === '') {
    printError('--reply is empty.');
    return 'invalid';
  }
  return text;
}

function outputFlags(options: OptionValues): { itemProgress: boolean } {
  return { itemProgress: options.progress === true };
}
