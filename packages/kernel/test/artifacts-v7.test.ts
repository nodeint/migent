import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collectWorkflowDraft, parseWorkflowMapping } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

import { migrateWorkflow, patchWorkflowText } from '../src/index.ts';
import { type ExecutionSnapshot,missingWorkflowOutputNames, resolveArtifactSources } from '../src/outputs.ts';
import { currentCompleteByStage } from '../src/selection.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parse(text: string) {
  return parseWorkflowMapping(parseYamlDocument(text) as Record<string, unknown>, 't.yaml');
}

const BASE = `schema_version: 7
id: plan
artifacts:
  plan: { file: plan.md, description: The plan. }
  plan-comments: { file: plan-comments.md, required: false }
stages:
  - id: plan
    role: planner
    artifacts: [plan]
  - id: review
    role: reviewer
    depends_on: [plan]
    decision:
      - approved:
          navigate: complete
          artifacts: [plan-comments]
      - revise:
          navigate: plan
          artifacts:
            review: { file: review.md, description: Findings. }
`;

test('v7 builds the registry, stage references and decision artifacts', () => {
  const document = parse(BASE);
  expect(document.schemaVersion).toBe(7);
  expect(document.artifacts?.map((a) => [a.id, a.file, a.required, a.producer])).toEqual([
    ['plan', 'plan.md', true, { stage: 'plan', decision: null }],
    ['plan-comments', 'plan-comments.md', false, { stage: 'review', decision: 'approved' }],
  ]);
  expect(document.stages.plan?.artifacts.map((a) => a.file)).toEqual(['plan.md']);
  expect(document.stages.review?.decisionArtifacts.approved?.[0]?.scope).toBe('published');
  expect(document.stages.review?.decisionArtifacts.revise?.[0]).toMatchObject({ id: 'review', scope: 'local', required: true });
  expect(document.outputs?.map((o) => o.name)).toEqual(['plan', 'plan-comments']);
});

const fails = (text: string, message: RegExp) => expect(() => parse(text)).toThrow(message);

test('v7 rejects produces, outputs and unreferenced or doubly produced artifacts', () => {
  fails(BASE.replace('    artifacts: [plan]\n', '    produces: { artifact: plan.md }\n'), /produces was removed/);
  fails(`${BASE}outputs: []\n`, /outputs was removed/);
  fails(BASE.replace('    artifacts: [plan]\n', ''), /not produced by any stage/);
  fails(BASE.replace('    artifacts: [plan]\n', '    artifacts: [plan]\n  - id: other\n    role: planner\n    artifacts: [plan]\n'), /more than one producer/);
});

test('v7 enforces the required rules', () => {
  fails(BASE.replace('plan-comments: { file: plan-comments.md, required: false }', 'plan-comments: { file: plan-comments.md }'), /must declare required: false/);
  fails(
    BASE.replace('  - id: plan\n    role: planner\n', "  - id: plan\n    role: planner\n    run_when: { changed_paths: ['src/**'] }\n"),
    /a skip would leave it missing/,
  );
  fails(BASE.replace('file: plan.md,', 'file: verify.md,'), /verify\.md/);
  fails(BASE.replace('file: review.md', 'file: plan-comments.md'), /already used/);
  fails(BASE.replace('review: { file: review.md', 'plan: { file: review.md'), /collides with a top-level artifact/);
  fails(BASE.replace('plan-comments: { file: plan-comments.md', 'other: { file: plan.md'), /outputs share one directory/);
  fails(BASE.replace('artifacts: [plan]\n  - id: review', 'artifacts: [nope]\n  - id: review'), /unknown artifact nope/);
});

test('optional artifacts may come from a run_when stage', () => {
  const text = BASE
    .replace('  plan: { file: plan.md, description: The plan. }', '  plan: { file: plan.md, required: false }')
    .replace('  - id: plan\n    role: planner\n', "  - id: plan\n    role: planner\n    run_when: { changed_paths: ['src/**'] }\n");
  expect(parse(text).artifacts?.[0]?.required).toBe(false);
});

test('the draft collector reports the same v7 problems with paths', () => {
  const draft = collectWorkflowDraft(parseYamlDocument(BASE.replace('artifacts: [plan]\n  - id: review', 'artifacts: [nope]\n  - id: review')) as Record<string, unknown>, 't.yaml');
  expect(draft.document).toBeNull();
  expect(draft.problems.some((p) => /unknown artifact nope/.test(p.message))).toBe(true);
  const clean = collectWorkflowDraft(parseYamlDocument(BASE) as Record<string, unknown>, 't.yaml');
  expect(clean.problems).toEqual([]);
  expect(clean.document).not.toBeNull();
});

function snap(stageId: string, order: number, directory: string, decision: string | null = null, status = 'completed'): ExecutionSnapshot {
  return {
    executionId: `e${order}`, stageId, executionOrder: order, status,
    outcomeStatus: status === 'completed' ? 'complete' : null, artifactDirectory: directory, outcomeDecision: decision,
  };
}

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-art-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, name), body);
  return root;
}

test("resolution picks the chosen decision's artifact and holds only required ones", () => {
  const document = parse(BASE);
  const planDir = dir({ 'plan.md': 'plan' });
  const approvedDir = dir({ 'plan-comments.md': 'notes' });
  const reviseDir = dir({ 'review.md': 'findings' });
  const approved = [snap('plan', 1, planDir), snap('review', 2, approvedDir, 'approved')];
  const sources = (snaps: ExecutionSnapshot[]) =>
    Object.fromEntries(resolveArtifactSources(document, currentCompleteByStage(document, snaps)).map((s) => [s.name, s.source?.executionId ?? null]));
  expect(sources(approved)).toEqual({ plan: 'e1', 'plan-comments': 'e2' });
  expect(missingWorkflowOutputNames(document, approved, currentCompleteByStage(document, approved))).toEqual([]);
  // A later revise round never revives the earlier approved comments.
  const revised = [...approved, snap('review', 3, reviseDir, 'revise')];
  expect(sources(revised)).toEqual({ plan: 'e1', 'plan-comments': null });
  // Optional artifacts never hold completion; a required one without a completion does.
  expect(missingWorkflowOutputNames(document, revised, currentCompleteByStage(document, revised))).toEqual([]);
  expect(missingWorkflowOutputNames(document, [], {})).toEqual(['plan']);
});

test('a skip supersedes the artifacts of the stages it reaches', () => {
  const text = `schema_version: 7
id: gate
artifacts:
  out: { file: out.md, required: false }
stages:
  - id: gate
    role: planner
    run_when: { changed_paths: ['src/**'] }
    artifacts: [out]
`;
  const document = parse(text);
  const first = dir({ 'out.md': 'x' });
  const done = [snap('gate', 1, first)];
  const skipped: ExecutionSnapshot[] = [...done, { ...snap('gate', 2, first, null, 'skipped'), outcomeStatus: null }];
  const view = (snaps: ExecutionSnapshot[]) => resolveArtifactSources(document, currentCompleteByStage(document, snaps))[0]?.source?.executionId ?? null;
  expect(view(done)).toBe('e1');
  expect(view(skipped)).toBeNull();
});

const V6 = `schema_version: 6
id: flow
stages:
  - id: plan
    role: planner
    produces:
      artifact: plan.md
  - id: scratch
    role: planner
    depends_on: [plan]
    produces:
      artifact: scratch.md
outputs:
  - name: plan
    from_stage: plan
    artifact: plan.md
downstream:
  - workflow: implement
    task: Implement.
    artifacts:
      plan: plan
`;

function migrate(text: string) {
  const raw = parseYamlDocument(text) as Record<string, unknown>;
  const notes = migrateWorkflow(raw, {});
  return { notes, text: patchWorkflowText(text, raw), raw };
}

test('migration converts v6 outputs and reports unpublished artifacts as now published', () => {
  const result = migrate(V6);
  expect(result.text).toContain('schema_version: 7');
  expect(result.text).not.toContain('produces:');
  expect(result.text).not.toContain('outputs:');
  const document = parse(result.text);
  expect(document.artifacts?.map((a) => [a.id, a.file])).toEqual([['plan', 'plan.md'], ['scratch', 'scratch.md']]);
  expect(result.notes.some((n) => /scratch.*now published/.test(n))).toBe(true);
});

test('migration marks run_when artifacts optional and merges output aliases', () => {
  const gated = V6.replace('  - id: plan\n    role: planner\n', "  - id: plan\n    role: planner\n    run_when:\n      changed_paths: ['src/**']\n").replace('outputs:\n  - name: plan\n    from_stage: plan\n    artifact: plan.md\n', 'outputs: []\n').replace('    artifacts:\n      plan: plan\n', '');
  const result = migrate(gated);
  const document = parse(result.text);
  expect(document.artifacts?.find((a) => a.id === 'plan')?.required).toBe(false);
  expect(result.notes.some((n) => /required: false/.test(n))).toBe(true);

  const aliased = V6.replace('    artifact: plan.md\ndownstream', '    artifact: plan.md\n  - name: plan_copy\n    from_stage: plan\n    artifact: plan.md\ndownstream').replace('      plan: plan\n', '      plan: plan_copy\n');
  const merged = migrate(aliased);
  const doc = parse(merged.text);
  expect(doc.artifacts?.map((a) => a.id)).toEqual(['plan', 'scratch']);
  expect(doc.downstream?.[0]?.artifacts).toEqual({ plan: 'plan' });
  expect(merged.notes.some((n) => /alias plan_copy merged/.test(n))).toBe(true);
});

test('migration refuses file collisions and invalid ids without changing the document', () => {
  const collide = V6.replace('scratch.md', 'plan.md');
  const raw = parseYamlDocument(collide) as Record<string, unknown>;
  const before = JSON.stringify(raw);
  expect(() => migrateWorkflow(raw, {})).toThrow(/both write plan\.md/);
  expect(JSON.stringify(raw)).toBe(before);
  const bad = V6.replace('name: plan\n', 'name: bad.name\n').replace('plan: plan\n', 'plan: bad.name\n');
  expect(() => migrateWorkflow(parseYamlDocument(bad) as Record<string, unknown>, {})).toThrow(/cannot derive an artifact id/);
});
