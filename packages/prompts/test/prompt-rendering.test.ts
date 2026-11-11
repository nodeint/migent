import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import {
  addArtifactContext, buildStageReplyPrompt, flattenHistory, formatQuestionAnswers,   renderHandoffCorrection, renderOutputCorrection, renderProtocolUpdate,
renderProviderPrompt, renderStageStart, renderVerifyRepair, type TurnKind,
} from '../src/index.ts';
import { renderPrompt } from '../src/renderer.ts';

// Contract inputs, including literal text that must not be escaped or evaluated.
const contracts = JSON.parse(readFileSync(new URL('./fixtures/prompt-contracts.json', import.meta.url), 'utf8'));
for (const example of contracts) {
  test(`renders the full contract (ask=${example.ask}, decisions=${example.values.length})`, () => {
    expect(renderProviderPrompt(example.body, {
      contract: true, protocol: 2, ask: example.ask, decisionValues: example.values,
      decisionInstructions: example.instructions, artifactDirectory: example.directory,
      artifactName: example.artifact, questionFile: example.questionFile,
    })).toMatchSnapshot();
  });
}

test('orders the stage prompt stable first: contract, stage, execution, ask', () => {
  const body = renderStageStart({
    taskFile: '/s/task.md', sessionDirectory: '/s',
    stage: { id: 'plan', role: 'planner', instructions: ['Stay at the architecture level.', 'Be brief.'], verify: [] },
    roleInstructions: ['Be brief.'], constraints: ['Plan only.'], upstream: [], routed: null, blocked: null, prior: null,
  });
  const prompt = renderProviderPrompt(body, {
    contract: true, protocol: 2, turn: 'start', ask: 'human', taskFile: '/s/task.md', sessionDirectory: '/s', questionFile: '/s/e1/question-request.json', artifactDirectory: '/s/e1/artifacts', artifactName: 'plan.md',
  });
  const order = ['# Migent workflow stage', '## Response contract', '## Asking questions', '## Stage: plan (role: planner)',
    '### Role', '### Instructions', '### Constraints', '## Execution', '## Do'].map((heading) => prompt.indexOf(`${heading}\n`));
  expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
  expect(prompt.match(/- Be brief\./g)).toHaveLength(1);
  expect(prompt).toContain('## Execution\n\n- Task: `/s/task.md`\n- Session dir: `/s` (shared session files)');
  expect(prompt).toContain('## Do\n\nRead the task, then carry out the stage.\nWrite the artifact as `plan.md`');
  expect(prompt).not.toContain('route');
  expect(prompt).toMatchSnapshot();
});

test('a reminder turn restates the status line and paths without the contract', () => {
  const prompt = renderProviderPrompt('## Human answers', {
    contract: 'reminder', protocol: 2, turn: 'answers', ask: 'human', questionFile: '/q.json', artifactDirectory: '/e2/artifacts',
    artifactName: 'plan.md', previousArtifactDirectory: '/e1/artifacts',
  });
  expect(prompt).not.toContain('## Response contract');
  expect(prompt).toBe([
    '## Human answers', '', '## Execution', '', '- Question file: `/q.json`', '- Artifacts: `/e2/artifacts`',
    '- Previous artifacts: `/e1/artifacts` (continue from these if present)', '', '## Do', '',
    'Continue the stage using these answers.',
    'Write the artifact as `plan.md` in the artifacts directory.',
    'Same response contract and stage instructions as before: start with `status: complete | question | blocked`.',
  ].join('\n'));
});

test('answers always show the selection, option IDs, and free text separately', () => {
  const questions = [
    { id: '1', question: 'Which season?', selection: 'single' as const, options: [{ id: 'A', label: 'Spring' }, { id: 'B', label: 'Winter' }] },
    { id: '2', question: 'Which drinks?', selection: 'multiple' as const, options: [{ id: 'A', label: 'Tea' }, { id: 'B', label: 'Coffee' }] },
  ];
  expect(formatQuestionAnswers(questions, [
    { question_id: '1', selected: ['B'] }, { question_id: '2', selected: [], text: 'wine' },
  ])).toBe([
    '1. Which season? (single)', '   - Selected: B. Winter', '',
    '2. Which drinks? (multiple)', '   - Selected: none', '   - Free text: "wine"',
  ].join('\n'));
});

test('renders context as literal data without escaping HTML or evaluating nested templates', () => {
  const content = '<tag> & `code` {{unknown}}\r\n  preserve spaces\n';
  expect(buildStageReplyPrompt(content, { interrupted: true })).toBe(
    `## Human reply\n\nYour previous turn was stopped by the human before it finished. Their message:\n\n${content}`,
  );
  expect(buildStageReplyPrompt(content, { answers: true })).toBe(
    `## Human answers\n\nAnswers to your latest questions.\n\n${content}`,
  );
  expect(flattenHistory([{ role: 'user', content }, { role: 'assistant', content: 'ok' }]))
    .toBe(`user: ${content}\n\nassistant: ok`);
  expect(renderProviderPrompt(content)).toBe(content);
  expect(addArtifactContext(content, 'unused')).toBe(content);
});

test('repair and previous verify report layout', () => {
  expect(renderVerifyRepair({ report: 'check <failed>\n', red: 1, maxVerify: 3, artifactPath: 'C:\\work\\result.md', taskFile: null, sessionDirectory: null })).toBe(
    '## Verify failed\n\n1 of 3 red runs.\n\n- Stage artifact: `C:\\work\\result.md` (update it if your fix changes it)\n\n### Report\n\ncheck <failed>\n',
  );
  expect(renderProviderPrompt('body', { previousVerifyReport: 'C:\\work\\verify.md' }))
    .toBe('body\n\n## Execution\n\n- Previous verify report: `C:\\work\\verify.md`');
});

test('a protocol update follows the old prompt and carries the full contract', () => {
  const update = renderProtocolUpdate({ ask: 'human', questionFile: '/q.json' });
  expect(update.startsWith('\n\n---\n\n# Response protocol update\n')).toBe(true);
  expect(update).toContain('## Asking questions');
  expect(update).toContain('- Question file: `/q.json`');
});

test('the closing instruction follows the turn kind', () => {
  const close = (turn: TurnKind, taskFile: string | null = '/s/task.md') =>
    renderProviderPrompt('body', { contract: true, protocol: 2, turn, taskFile, sessionDirectory: '/s' }).split('## Do\n\n')[1]!.split('\n')[0];
  expect(close('start')).toBe('Read the task, then carry out the stage.');
  expect(close('start', null)).toBe('Carry out the stage.');
  expect(close('continue')).toBe('Read the task, then continue the stage with the context above.');
  expect(close('reply')).toBe('Continue the stage with the human reply above.');
  expect(close('answers')).toBe('Continue the stage using these answers.');
  expect(close('repair')).toBe('Fix the verify failure above, then report again.');
  expect(close('correction')).toBe('Rewrite the whole question file as one valid JSON document, then respond again.');
  expect(close('response_correction')).toBe('Send the response again in the required format. Do not redo the work.');
  expect(close('output_correction')).toBe('Write the missing files, then report again.');
  expect(renderProviderPrompt('body', { contract: true })).toContain('## Do\n\nCarry out the request above.');
});

test('protocol 3 asks for one handoff file and names it under Execution', () => {
  const prompt = renderProviderPrompt('body', {
    contract: true, turn: 'start', ask: 'human', decisionValues: ['approved', 'revise'],
    taskFile: '/s/task.md', sessionDirectory: '/s', handoffFile: '/s/e1/handoff.json',
    artifactDirectory: '/s/e1/artifacts', artifactName: 'plan.md',
  });
  expect(prompt).toContain('Write one JSON document to the handoff file');
  expect(prompt).toContain('"status":"question"');
  expect(prompt).toContain('"decision":"approved"');
  expect(prompt).toContain('`decision` is one of approved|revise.');
  expect(prompt).toContain('- Handoff file: `/s/e1/handoff.json`');
  expect(prompt).not.toContain('Question file');
  expect(prompt).not.toContain('start with a status header');
  expect(prompt).toMatchSnapshot();
});

test('a protocol 3 reminder restates the handoff contract', () => {
  const prompt = renderProviderPrompt('## Human answers', {
    contract: 'reminder', turn: 'answers', ask: 'human', handoffFile: '/h.json', artifactDirectory: '/a', artifactName: 'plan.md',
  });
  expect(prompt).not.toContain('## Response contract');
  expect(prompt).toContain('- Handoff file: `/h.json`');
  expect(prompt).toContain('write the handoff file with `status` complete | question | blocked');
});

test('protocol 3 turn kinds that report again rewrite the handoff file', () => {
  const close = (turn: TurnKind) =>
    renderProviderPrompt('body', { contract: true, turn, handoffFile: '/h.json' }).split('## Do\n\n')[1]!.split('\n')[0];
  expect(close('repair')).toBe('Fix the verify failure above, then rewrite the handoff file.');
  expect(close('output_correction')).toBe('Write the missing files, then rewrite the handoff file.');
  expect(close('handoff_correction')).toBe('Rewrite the whole handoff file as one valid JSON document, then respond again.');
});

test('the handoff correction names the file, the kind and the detail', () => {
  const message = renderHandoffCorrection({ handoffFile: '/h.json', errorKind: 'invalid_json', errorDetail: 'Unexpected token' });
  expect(message).toContain('`/h.json`');
  expect(message).toContain('(invalid_json): Unexpected token');
  expect(message).toContain('Rewrite only the handoff file');
});

test('the output correction under protocol 3 asks to rewrite the handoff file', () => {
  const message = renderOutputCorrection({ errorKind: 'artifact', errorDetail: 'x', handoffFile: '/h.json' });
  expect(message).toContain('rewrite the handoff file `/h.json`');
  expect(renderOutputCorrection({ errorKind: 'artifact', errorDetail: 'x' })).toContain('then report again.');
});

test('a protocol update always carries the protocol 2 contract', () => {
  const update = renderProtocolUpdate({ ask: 'human', questionFile: '/q.json', handoffFile: '/h.json' });
  expect(update).toContain('Start the response with a status header');
  expect(update).not.toContain('Handoff file');
});

test('missing template data fails rather than silently omitting content', () => {
  expect(() => renderPrompt('stage-reply', {})).toThrow();
});

test('every JSON example in the protocol 3 contract is a valid handoff document', () => {
  const prompt = renderProviderPrompt('body', { contract: true, ask: 'human', decisionValues: ['approved', 'revise'], handoffFile: '/h.json' });
  const block = /```json\n([\s\S]*?)\n```/.exec(prompt)![1]!;
  const lines = block.split('\n');
  expect(lines).toHaveLength(3);
  const documents = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(documents.map((document) => document.status)).toEqual(['complete', 'blocked', 'question']);
  expect(documents[0]!.decision).toBe('approved');
  const question = (documents[2]!.questions as Record<string, unknown>[])[0]!;
  expect(['single', 'multiple']).toContain(question.selection);
  expect((question.options as unknown[]).length).toBeGreaterThanOrEqual(2);
});
