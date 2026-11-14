import Type, { type Static } from 'typebox';

import { id, nullable } from './common.js';
import { DIAGNOSTICS_SCHEMA_VERSION, EXECUTION_INPUT_SCHEMA_VERSION, EXECUTION_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION, NEXT_SCHEMA_VERSION, QUESTIONS_SCHEMA_VERSION } from './data/versions.js';

/**
 * Persisted files under `.migent/sessions/<id>/`. Objects are open: readers ignore unknown fields.
 * A field is required only when every current writer path emits it; fields added by later
 * releases are optional. `guaranteed` and `known` follow the README stability classes.
 */

const str = () => Type.String();
const num = () => Type.Number();
const obj = () => Type.Record(Type.String(), Type.Unknown());
const opt = Type.Optional;

// ---- manifest.yaml ----------------------------------------------------------------------------

const ManifestV2 = Type.Object(
  {
    session_id: str(),
    created_at: str(),
    schema_version: Type.Literal(MANIFEST_SCHEMA_VERSION),
    workflow_id: str(),
    title: opt(str()),
    workflow_path: opt(str()),
    task: opt(str()),
    role: opt(str()),
    prior_session_id: opt(str()),
    handoff: opt(obj()),
  },
  { title: 'Manifest (schema 2)', description: 'Identity only. The status lives in `status.json`.' },
);

const ManifestV1 = Type.Object(
  {
    session_id: str(),
    created_at: str(),
    status: str(),
    schema_version: opt(Type.Literal(1)),
    title: opt(str()),
    workflow_id: opt(str()),
  },
  { title: 'Manifest (schema 1)', description: 'Version 1, or a manifest with no `schema_version`. It carries a `status` line.' },
);

export const SessionManifest = Type.Union([ManifestV2, ManifestV1], {
  $id: id('session/manifest'),
  title: 'Session manifest (`manifest.yaml`)',
  description: 'The parsed YAML document of `manifest.yaml`.',
});
export type SessionManifest = Static<typeof SessionManifest>;

// ---- session.lock -----------------------------------------------------------------------------

export const SessionLockFile = Type.Object(
  { pid: num(), host: str(), started_at: str(), heartbeat_at: str(), nonce: str() },
  { $id: id('session/lock'), title: 'Session lock (`session.lock`)', description: 'Written while a process runs the session.' },
);
export type SessionLockFile = Static<typeof SessionLockFile>;

// ---- questions.json ---------------------------------------------------------------------------

const QuestionBody = {
  question: opt(str()),
  context: opt(str()),
  selection: opt(Type.Union([Type.Literal('single'), Type.Literal('multiple')])),
  options: opt(Type.Array(obj())),
  recommended: opt(Type.Array(str())),
};

export const SessionQuestions = Type.Object(
  {
    schema_version: Type.Literal(QUESTIONS_SCHEMA_VERSION),
    questions: Type.Array(
      Type.Object({
        id: str(),
        execution_id: str(),
        stage_id: str(),
        recipient: str(),
        status: Type.Union([Type.Literal('answered'), Type.Literal('pending'), Type.Literal('superseded')]),
        answer: nullable(obj()),
        answered_at: opt(str()),
        ...QuestionBody,
      }),
      { description: 'Every question and answer of the session, across executions.' },
    ),
  },
  {
    $id: id('session/questions'),
    title: 'Session questions (`questions.json`)',
    description: 'Historical. Written by Migent up to 0.7. No longer written or updated. Old sessions may still contain it.',
  },
);
export type SessionQuestions = Static<typeof SessionQuestions>;

export const ExecutionQuestions = Type.Object(
  {
    schema_version: Type.Literal(QUESTIONS_SCHEMA_VERSION),
    stage_id: str(),
    execution_id: str(),
    recipient: str(),
    questions: Type.Array(Type.Object({ id: opt(str()), ...QuestionBody })),
  },
  { $id: id('session/execution-questions'), title: 'Execution questions (`executions/<id>/questions.json`)' },
);
export type ExecutionQuestions = Static<typeof ExecutionQuestions>;

export const ExecutionInput = Type.Object(
  {
    schema_version: Type.Literal(EXECUTION_INPUT_SCHEMA_VERSION),
    execution_id: str(),
    stage_id: str(),
    kind: Type.Union([Type.Literal('reply'), Type.Literal('answers')]),
    responds_to_execution_id: str(),
    recorded_at: str(),
    sent: str(),
    input: str(),
    answers: opt(Type.Array(obj())),
  },
  {
    $id: id('session/execution-input'),
    title: 'Execution input (`executions/<id>/input.json`)',
    description: 'The human input that opened this attempt. Written once, before execution.json. Absent when no human input was sent.',
  },
);
export type ExecutionInput = Static<typeof ExecutionInput>;

// ---- next.json --------------------------------------------------------------------------------

export const SessionNext = Type.Object(
  {
    schema_version: Type.Literal(NEXT_SCHEMA_VERSION),
    source_session_id: str(),
    next: Type.Array(
      Type.Object({
        workflow: str(),
        task: str(),
        artifacts: Type.Record(Type.String(), Type.Object({ output: str(), path: str() })),
        argv: Type.Array(str()),
        command: opt(str()),
      }),
    ),
  },
  { $id: id('session/next'), title: 'Next suggestions (`next.json`)' },
);
export type SessionNext = Static<typeof SessionNext>;

// ---- status.json ------------------------------------------------------------------------------

export const SessionStatusFile = Type.Object(
  {
    session_id: str(),
    status: str(),
    title: opt(str()),
    workflow_id: opt(str()),
    workflow_path: opt(str()),
    task: opt(str()),
    created_at: opt(str()),
    updated_at: opt(str()),
    prior_session_id: opt(str()),
    handoff: opt(obj()),
    baseline: opt(obj()),
    task_sha256: opt(str()),
    latest_provider_event: opt(obj()),
    outputs: opt(obj()),
    latest_execution_id: opt(str()),
    latest_execution_status: opt(str()),
    latest_stage_id: opt(str()),
    latest_decision: opt(str()),
    completion_method: opt(str()),
    terminal_execution_id: opt(str()),
  },
  { $id: id('session/status'), title: 'Session status (`status.json`)', description: 'Derived from `events.jsonl`. It has no `schema_version`; fields added over time are optional.' },
);
export type SessionStatusFile = Static<typeof SessionStatusFile>;

// ---- execution.json ---------------------------------------------------------------------------

export const SessionExecution = Type.Object(
  {
    session_id: str(),
    execution_id: str(),
    execution_order: num(),
    stage_id: str(),
    stage_attempt: num(),
    status: str(),
    created_at: str(),
    schema_version: opt(Type.Union([Type.Literal(EXECUTION_SCHEMA_VERSION), Type.Literal(1)])),
    completed_at: opt(nullable(str())),
    client: opt(nullable(str())),
    model: opt(nullable(str())),
    options: opt(obj()),
    agent_id: opt(nullable(str())),
    resumes_execution_id: opt(nullable(str())),
    artifact_directory: opt(str()),
    kind: opt(str()),
    skip: opt(obj()),
    error: opt(str()),
    failure_reason: opt(nullable(str())),
    outcome: opt(obj()),
    final_turn: opt(num()),
    turns: opt(Type.Unknown()),
    verify: opt(Type.Unknown()),
    corrections: opt(obj()),
    response_protocol: opt(num()),
    turn_kind: opt(str()),
    hostname: opt(str()),
    owner_pid: opt(num()),
    provider_pid: opt(nullable(num())),
    provider_endpoint: opt(nullable(str())),
  },
  { $id: id('session/execution'), title: 'Execution (`executions/<id>/execution.json`)', description: '`schema_version` is 2, 1, or absent. `final_turn` and `response_protocol` are missing from older files.' },
);
export type SessionExecution = Static<typeof SessionExecution>;

// ---- diagnostics.json -------------------------------------------------------------------------

const DiagnosticsV2 = Type.Object(
  {
    schema_version: Type.Literal(DIAGNOSTICS_SCHEMA_VERSION),
    turn: num(),
    recorded_at: str(),
    agent_id: nullable(str()),
    failure: Type.Object({
      kind: str(),
      origin: str(),
      message: str(),
      phase: opt(nullable(str())),
      code: opt(nullable(str())),
      errno: opt(Type.Unknown()),
      syscall: opt(nullable(str())),
      path: opt(nullable(str())),
      exit_code: opt(nullable(num())),
      signal: opt(nullable(str())),
    }),
    stderr_tail: str(),
    stderr: obj(),
    stream_summary: nullable(obj()),
    result_state: obj(),
    command: Type.Object({ executable: str(), argument_count: num() }),
    cwd: opt(str()),
    endpoint: opt(str()),
    endpoint_length: opt(num()),
    migent_version: opt(str()),
    node_version: opt(str()),
    platform: opt(str()),
    arch: opt(str()),
    timings: opt(obj()),
  },
  { title: 'Diagnostics (schema 2)' },
);

const DiagnosticsV1 = Type.Object(
  {
    schema_version: Type.Literal(1),
    failure: opt(obj()),
    stderr_tail: opt(str()),
  },
  { title: 'Diagnostics (schema 1)', description: 'Wrapper failures only. Still read.' },
);

export const SessionDiagnostics = Type.Union([DiagnosticsV2, DiagnosticsV1], {
  $id: id('session/diagnostics'),
  title: 'Diagnostics (`executions/<id>/diagnostics.json`)',
  description: 'The record of one abnormal provider turn.',
});
export type SessionDiagnostics = Static<typeof SessionDiagnostics>;
