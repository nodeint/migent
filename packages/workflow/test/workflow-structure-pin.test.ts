import { isValid,WorkflowDocumentInput } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { collectWorkflowDraft, parseWorkflowMapping } from '../src/index.ts';

type Mapping = Record<string, unknown>;

const stage = (id: string, extra: Mapping = {}): Mapping => ({ id, role: 'developer', depends_on: [], ...extra });
const doc = (stages: unknown[], extra: Mapping = {}): Mapping => ({ schema_version: 7, id: 'w', stages, ...extra });

const cases: Record<string, Mapping> = {
  'stage not a mapping': doc(['a']),
  'stages not a list': doc([], { stages: 'x' }),
  'stage id blank': doc([stage(' ')]),
  'description list': doc([stage('a', { description: ['x'] })]),
  'description multiline': doc([stage('a', { description: 'x\ny' })]),
  'role number': doc([stage('a', { role: 3 })]),
  'ask bot': doc([stage('a', { ask: 'bot' })]),
  'agent number': doc([stage('a', { agent: 3 })]),
  'agent blank': doc([stage('a', { agent: ' ' })]),
  'max_revisions negative': doc([stage('a', { max_revisions: -1 })]),
  'max_revisions text': doc([stage('a', { max_revisions: 'x' })]),
  'verify empty': doc([stage('a', { verify: [] })]),
  'verify number item': doc([stage('a', { verify: [3] })]),
  'verify multiline': doc([stage('a', { verify: ['a\nb'] })]),
  'max_verify zero': doc([stage('a', { verify: 't', max_verify: 0 })]),
  'max_verify without verify': doc([stage('a', { max_verify: 2 })]),
  'verify_timeout text': doc([stage('a', { verify: 't', verify_timeout: 'x' })]),
  'depends_on string': doc([stage('a', { depends_on: 'b' })]),
  'instructions string': doc([stage('a', { instructions: 'x' })]),
  'run_when list': doc([stage('a', { run_when: [] })]),
  'run_when unknown key': doc([stage('a', { run_when: { x: 1 } })]),
  'run_when paths string': doc([stage('a', { run_when: { changed_paths: 'x' } })]),
  'decision mapping': doc([stage('a', { decision: { x: 1 } })]),
  'decision empty': doc([stage('a', { decision: [] })]),
  'decision two keys': doc([stage('a', { decision: [{ x: { navigate: 'complete' }, y: { navigate: 'complete' } }] })]),
  'decision entry string': doc([stage('a', { decision: [{ x: 'complete' }] })]),
  'decision entry unknown key': doc([stage('a', { decision: [{ x: { navigate: 'complete', bogus: 1 } }] })]),
  'decision no navigate': doc([stage('a', { decision: [{ x: { when: 'w' } }] })]),
  'decision when number': doc([stage('a', { decision: [{ x: { when: 3, navigate: 'complete' } }] })]),
  'decision duplicate': doc([stage('a', { decision: [{ x: { navigate: 'complete' } }, { X: { navigate: 'complete' } }] })]),
  'session list': doc([stage('a', { session: [] })]),
  'session unknown': doc([stage('a', { session: { x: 1 } })]),
  'produces v7': doc([stage('a', { produces: { artifact: 'a.md' } })]),
  'artifacts not mapping': doc([stage('a')], { artifacts: [] }),
  'artifact not mapping': doc([stage('a', { artifacts: ['x'] })], { artifacts: { x: 'f.md' } }),
  'artifact bad id': doc([stage('a')], { artifacts: { '1x': { file: 'f.md' } } }),
  'artifact unknown key': doc([stage('a', { artifacts: ['x'] })], { artifacts: { x: { file: 'f.md', z: 1 } } }),
  'artifact file path': doc([stage('a', { artifacts: ['x'] })], { artifacts: { x: { file: 'a/b.md' } } }),
  'artifact file missing': doc([stage('a', { artifacts: ['x'] })], { artifacts: { x: {} } }),
  'artifact required text': doc([stage('a', { artifacts: ['x'] })], { artifacts: { x: { file: 'f.md', required: 'yes' } } }),
  'artifact description number': doc([stage('a', { artifacts: ['x'] })], { artifacts: { x: { file: 'f.md', description: 3 } } }),
  'stage artifacts string': doc([stage('a', { artifacts: 'x' })]),
  'stage artifact number': doc([stage('a', { artifacts: [3] })]),
  'concurrency zero': doc([stage('a')], { concurrency: 0 }),
  'concurrency text': doc([stage('a')], { concurrency: 'x' }),
  'constraints string': doc([stage('a')], { constraints: 'x' }),
  'downstream string': doc([stage('a')], { downstream: 'x' }),
  'downstream entry string': doc([stage('a')], { downstream: ['x'] }),
  'downstream unknown': doc([stage('a')], { downstream: [{ workflow: 'n', task: 't', z: 1 }] }),
  'downstream task multiline': doc([stage('a')], { downstream: [{ workflow: 'n', task: 't\nu' }] }),
  'downstream artifacts list': doc([stage('a')], { downstream: [{ workflow: 'n', task: 't', artifacts: [] }] }),
  'completion': doc([stage('a')], { completion: { stage: 'a' } }),
  'unknown top key': doc([stage('a')], { bogus: 1 }),
  'id number': doc([stage('a')], { id: 3 }),
  'schema_version text': doc([stage('a')], { schema_version: 'x' }),
};

const strict = (data: Mapping): unknown => {
  try {
    parseWorkflowMapping(data, 'w.yaml');
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; path?: unknown; message: string };
    return { code: e.code, path: e.path, message: e.message };
  }
};

test('strict reader diagnostics', () => {
  expect(Object.fromEntries(Object.entries(cases).map(([name, data]) => [name, strict(data)]))).toMatchSnapshot();
});

test('draft collector diagnostics', () => {
  expect(
    Object.fromEntries(
      Object.entries(cases).map(([name, data]) => [name, collectWorkflowDraft(data, 'w.yaml').problems]),
    ),
  ).toMatchSnapshot();
});

test('contract and loader disagree only on semantic rules', () => {
  const disagree = Object.entries(cases)
    .filter(([, data]) => (strict(data) === 'ok') !== isValid(WorkflowDocumentInput, data))
    .map(([name]) => name);
  expect(disagree).toMatchSnapshot();
});
