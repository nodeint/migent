import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';

import type { TurnKind } from '../src/index.ts';
import type { ExecutionSnapshot } from '../src/outputs.ts';
import { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, buildVerifyRepairPrompt } from '../src/prompt.ts';
import { flattenHistory, renderProviderPrompt } from '../src/runtime.ts';

// Neutral fixture: no role or stage instructions, so every prompt line below comes from the engine.
const workflow = parseWorkflowMapping({
  schema_version: 3,
  id: 'neutral',
  stages: [
    { id: 'make', role: 'worker', depends_on: [], max_revisions: 2, ask: 'human', verify: ['check-one', 'check-two'], produces: { artifact: 'make.md' } },
    {
      id: 'check', role: 'checker', depends_on: ['make'],
      decision: [{ approved: { when: 'A.', navigate: 'complete' } }, { revise: { when: 'B.', navigate: 'make' } }],
    },
    { id: 'again', role: 'worker', depends_on: ['make'], session: { resume_from: 'make' }, produces: { artifact: 'again.md' } },
  ],
}, 'neutral.yaml');

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'migent-baseline-'))); // macOS tmp is a symlink; prompts print resolved paths
  const session = path.join(root, '.migent', 'sessions', 's1');
  const execution = (name: string, artifacts: boolean) => {
    const dir = path.join(session, 'executions', name);
    mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    writeFileSync(path.join(dir, 'response.md'), 'status: complete\n');
    if (artifacts) writeFileSync(path.join(dir, 'artifacts', 'make.md'), 'x');
    return path.join(dir, 'artifacts');
  };
  const snap = (executionId: string, stageId: string, order: number, artifactDirectory: string, outcomeStatus: string, decision: string | null = null): ExecutionSnapshot =>
    ({ executionId, stageId, executionOrder: order, status: 'completed', outcomeStatus, outcomeDecision: decision, artifactDirectory });
  const snapshots = [
    snap('e1', 'make', 1, execution('e1', true), 'complete'),
    snap('e2', 'check', 2, execution('e2', false), 'complete', 'revise'),
  ];
  return { root, session, snapshots };
}

const normalize = (text: string, root: string) =>
  text.split(root).join('<ROOT>').split(root.replaceAll('\\', '/')).join('<ROOT>').replaceAll('\\', '/');

function turn(prompt: string, stageId: string, kind: TurnKind, protocol = 2) {
  const stage = workflow.stages[stageId]!;
  return renderProviderPrompt(prompt, {
    contract: true, protocol, handoffFile: '<HANDOFF>', turn: kind, decisionValues: stage.decisionValues, decisionInstructions: stage.decisionInstructions,
    ask: stage.ask ?? null, questionFile: '<QFILE>', artifactDirectory: '<ART>', artifactName: stage.artifacts[0]?.file ?? null,
    taskFile: '<SESSION>/task.md', sessionDirectory: '<SESSION>',
  });
}

for (const protocol of [2, 3]) test(protocol === 2 ? 'prompt kinds under native resume, history replay and resume_from' : 'protocol 3 prompt kinds under native resume, history replay and resume_from', () => {
  const { root, session, snapshots } = fixture();
  const base = { workflow, workspace: root, sessionDirectory: session, taskFile: path.join(session, 'task.md'), roleInstructions: [] as string[] };
  const kinds: Record<string, string> = {};
  const record = (name: string, stageId: string, kind: TurnKind, body: string) => {
    kinds[`${name} / native`] = turn(body, stageId, kind, protocol);
    kinds[`${name} / replay`] = flattenHistory([
      { role: 'user', content: '(earlier turn)' }, { role: 'assistant', content: '(earlier response)' },
      { role: 'user', content: turn(body, stageId, kind, protocol) },
    ]);
  };
  record('first turn', 'make', 'start', buildStagePrompt({ ...base, stageId: 'make', snapshots: [] }));
  record('re-entry after revise', 'make', 'continue', buildStageResumePrompt({ ...base, stageId: 'make', snapshots }));
  record('first turn (resume_from)', 'again', 'start', buildStagePrompt({ ...base, stageId: 'again', snapshots }));
  record('re-entry (resume_from)', 'again', 'continue', buildStageResumePrompt({ ...base, stageId: 'again', snapshots }));
  record('reply to human answer', 'make', 'answers', buildStageReplyPrompt('1. Pick one? (single)\n   - Selected: A. Yes', { answers: true }));
  record('reply to cancelled stage', 'make', 'reply', buildStageReplyPrompt('go on', { interrupted: true }));
  record('verify repair', 'make', 'repair', buildVerifyRepairPrompt('check-one failed\n', { red: 1, maxVerify: 3, artifactPath: path.join(session, 'make.md') }, { taskFile: base.taskFile, sessionDirectory: session }));

  const normalized = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, normalize(v, root)]));
  expect(normalized).toMatchSnapshot();
  if (protocol === 3) expect(Object.values(normalized).every((text) => !text.includes('<QFILE>'))).toBe(true);
  console.log('PROMPT SIZES', JSON.stringify(Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, v.length]))));
});
