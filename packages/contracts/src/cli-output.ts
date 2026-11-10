import Type, { type Static } from "typebox";
import { Diagnostic, NextSuggestion, id, listOf, nullable } from "./common.js";

const strings = () => Type.Array(Type.String());
const record = () => Type.Record(Type.String(), Type.Unknown());
const options = () => Type.Record(Type.String(), Type.String());
const int = () => Type.Number();

// ---- config --json ----------------------------------------------------------------------------

export const ConfigSummary = Type.Object(
  {
    config: record(),
    local: nullable(Type.Object({ file: Type.String(), agents: strings() })),
  },
  { $id: id("cli/config"), title: "config --json", description: "Effective config and the local overlay." },
);
export type ConfigSummary = Static<typeof ConfigSummary>;

// ---- authoring envelope -----------------------------------------------------------------------

export const AuthoringEnvelope = Type.Object(
  {
    schema_version: Type.Literal(1),
    command: Type.String({ description: "config|workflow . validate|render|save." }),
    valid: Type.Boolean(),
    diagnostics: Type.Array(Diagnostic),
    rendered: Type.Optional(Type.String({ description: "render: the canonical text." })),
    file: Type.Optional(Type.String({ description: "save: the target label." })),
    hash: Type.Optional(Type.String({ description: "save: SHA-256 of the written file." })),
    written: Type.Optional(Type.Boolean()),
    current_hash: Type.Optional(Type.String({ description: "save conflict: hash on disk." })),
  },
  { $id: id("cli/authoring"), title: "config|workflow validate|render|save --json", description: "Versioned authoring envelope; also used for invocation errors." },
);
export type AuthoringEnvelope = Static<typeof AuthoringEnvelope>;

// ---- doctor -----------------------------------------------------------------------------------

export const DoctorCheck = Type.Object(
  { name: Type.String(), ok: Type.Boolean(), items: strings(), problems: strings(), warnings: strings() },
  { $id: id("common/check"), title: "Doctor check" },
);
export const DoctorReport = Type.Object(
  {
    ok: Type.Boolean(),
    checks: Type.Array(DoctorCheck),
    session: Type.Optional(
      Type.Object({
        id: Type.String(),
        workflow_id: nullable(Type.String()),
        source: nullable(Type.String()),
        path: nullable(Type.String()),
      }),
    ),
  },
  { $id: id("cli/doctor"), title: "doctor --json", description: "Checks; `session` is present with --session." },
);
export type DoctorReport = Static<typeof DoctorReport>;

// ---- get views --------------------------------------------------------------------------------

const UsedByStage = Type.Object({ stage: Type.String(), workflow: Type.String() });
const Target = Type.Object({ client: Type.String(), model: Type.String(), options: options() });
const ArtifactView = Type.Object({ id: Type.Optional(Type.String()), file: Type.String() });

const StageArtifactView = Type.Object({
  id: Type.String(),
  file: Type.String(),
  description: nullable(Type.String()),
  required: Type.Boolean(),
  scope: Type.Union([Type.Literal("published"), Type.Literal("local")]),
});
const Route = Type.Union([Type.String(), Type.Array(Type.String())]);
const ArtifactProducer = Type.Object({ stage: Type.String(), decision: nullable(Type.String()) });

export const StageView = Type.Object(
  {
    id: Type.String(),
    role: nullable(Type.String()),
    description: nullable(Type.String()),
    depends_on: strings(),
    agent: nullable(Type.Union([Type.String(), Type.Object({ inline: Type.Literal(true) })])),
    options: options(),
    artifact: nullable(Type.String()),
    artifacts: Type.Array(StageArtifactView),
    decision_artifacts: Type.Record(Type.String(), Type.Array(StageArtifactView)),
    decisions: Type.Array(Type.Object({ value: Type.String(), when: nullable(Type.String()), navigate: nullable(Route) })),
    max_revisions: nullable(int()),
    resume_from: nullable(Type.String()),
    verify: strings(),
    max_verify: int(),
    verify_timeout: nullable(int()),
    run_when: nullable(Type.Object({ changed_paths: strings() })),
    ask: nullable(Type.String()),
    target: nullable(Target),
    problems: strings(),
  },
  { $id: id("common/stage-view"), title: "Workflow stage view" },
);

export const GetWorkflowSummary = Type.Object(
  {
    kind: Type.Literal("workflow"),
    name: nullable(Type.String()),
    file: nullable(Type.String()),
    stages: strings(),
    roles: strings(),
    problems: strings(),
  },
  { $id: id("cli/get-workflow-summary"), title: "get workflows -o json item" },
);
export const GetWorkflow = Type.Object(
  {
    kind: Type.Literal("workflow"),
    name: Type.String(),
    file: nullable(Type.String()),
    source: Type.Object({ kind: Type.String(), path: nullable(Type.String()) }),
    session: Type.Optional(Type.String()),
    concurrency: int(),
    constraints: strings(),
    stages: Type.Array(StageView),
    artifacts: Type.Array(
      Type.Object({ id: Type.String(), file: Type.String(), description: nullable(Type.String()), required: Type.Boolean(), producer: ArtifactProducer }),
    ),
    outputs: Type.Array(Type.Object({ name: Type.String(), from_stage: Type.String(), artifact: Type.String() })),
    requires: nullable(Type.Object({ workflow: Type.String() })),
    downstream: Type.Array(Type.Object({ workflow: Type.String(), task: Type.String(), artifacts: nullable(Type.Record(Type.String(), Type.String())) })),
    role_responsibilities: Type.Record(Type.String(), strings()),
    warnings: strings(),
    problems: strings(),
  },
  { $id: id("cli/get-workflow"), title: "get workflow <name> -o json" },
);
export const GetRole = Type.Object(
  {
    kind: Type.Literal("role"),
    name: Type.String(),
    agent: nullable(Type.String()),
    description: nullable(Type.String()),
    responsibilities: strings(),
    target: nullable(Target),
    used_by: Type.Array(UsedByStage),
    problems: strings(),
  },
  { $id: id("cli/get-role"), title: "get role(s) -o json" },
);
export const GetAgent = Type.Object(
  {
    kind: Type.Literal("agent"),
    name: Type.String(),
    client: nullable(Type.String()),
    model: nullable(Type.String()),
    effort: nullable(Type.String()),
    local: Type.Boolean(),
    options: options(),
    used_by: Type.Array(Type.Union([Type.Object({ role: Type.String() }), UsedByStage])),
    problems: strings(),
  },
  { $id: id("cli/get-agent"), title: "get agent(s) -o json" },
);
export const GetConfig = Type.Object(
  { kind: Type.Literal("config"), name: Type.Literal("config"), config: record(), local_file: nullable(Type.String()), local_agents: strings() },
  { $id: id("cli/get-config"), title: "get config -o json" },
);
export const GetClient = Type.Object(
  {
    kind: Type.Literal("client"),
    name: Type.String(),
    command: Type.String(),
    available: Type.Boolean(),
    path: nullable(Type.String()),
    effort_option: nullable(Type.String()),
    problems: strings(),
  },
  { $id: id("cli/get-client"), title: "get client(s) -o json" },
);
export const GetModel = Type.Object(
  { kind: Type.Literal("model"), name: Type.String(), client: Type.String(), default: Type.Boolean() },
  { $id: id("cli/get-model"), title: "get model(s) -o json" },
);
export const GetOption = Type.Object(
  {
    kind: Type.Literal("option"),
    name: Type.String(),
    client: Type.String(),
    source: Type.Literal("configured"),
    prompt: Type.Boolean(),
    allow_default: Type.Boolean(),
    overridable: Type.Boolean(),
  },
  { $id: id("cli/get-option"), title: "get option(s) -o json" },
);
export const GetNativeOption = Type.Object(
  {
    kind: Type.Literal("option"),
    name: Type.String(),
    client: Type.String(),
    source: Type.Literal("native"),
    flags: strings(),
    description: Type.String(),
    argument: nullable(Type.String()),
    value_mode: Type.String(),
    type: Type.String(),
    choices: nullable(strings()),
    default: nullable(Type.String()),
  },
  { $id: id("cli/get-native-option"), title: "get options --native -o json" },
);
/** What `get option` can print; the command picks the branch by `--native`. */
export const GetAnyOption = Type.Union([GetOption, GetNativeOption]);
export const GetEffort = Type.Object(
  {
    kind: Type.Literal("effort"),
    name: Type.String(),
    client: Type.String(),
    model: Type.String(),
    option: nullable(Type.String()),
    values: strings(),
  },
  { $id: id("cli/get-effort"), title: "get effort(s) -o json" },
);

export const GetWorkflowSummaryList = listOf(GetWorkflowSummary);
export const GetRoleList = listOf(GetRole);
export const GetAgentList = listOf(GetAgent);
export const GetClientList = listOf(GetClient);
export const GetModelList = listOf(GetModel);
export const GetOptionList = listOf(GetOption);
export const GetNativeOptionList = listOf(GetNativeOption);
export const GetEffortList = listOf(GetEffort);

// ---- sessions ---------------------------------------------------------------------------------

export const SessionRow = Type.Object(
  {
    session: Type.String(),
    title: Type.String(),
    workflow: Type.String(),
    status: Type.String(),
    execution: Type.String(),
    decision: Type.String(),
    outputs: Type.String(),
  },
  { $id: id("cli/session-row"), title: "session list --latest --json (a session)" },
);
export const SessionNone = Type.Null({ $id: id("cli/session-none"), title: "session list --latest --json (no session)" });
export const SessionRowOrNull = Type.Union([SessionRow, SessionNone], { $id: id("cli/session-latest"), title: "session list --latest --json" });
export const SessionRows = listOf(SessionRow);

const Option = Type.Object({ id: Type.String(), label: Type.String(), description: Type.Optional(Type.String()) });
export const Question = Type.Object(
  {
    id: Type.String(),
    question: Type.String(),
    context: Type.String(),
    selection: Type.Union([Type.Literal("single"), Type.Literal("multiple")]),
    options: Type.Array(Option),
    recommended: Type.Optional(strings()),
  },
  { $id: id("common/question"), title: "Question an agent asked" },
);
const SnapshotQuestion = Type.Object({
  ...Question.properties,
  execution_id: Type.String(),
  stage_id: Type.String(),
  recipient: Type.String(),
});
export const StageOutcomeView = Type.Object(
  {
    status: Type.String(),
    blocker: Type.Optional(Type.String()),
    decision: Type.Optional(Type.String()),
    question: Type.Optional(Type.String()),
    questions: Type.Optional(Type.Array(Question)),
  },
  { $id: id("common/stage-outcome"), title: "Stage outcome" },
);
export const OutputRef = Type.Object(
  {
    path: Type.Optional(Type.String()),
    source_execution_id: Type.Optional(Type.String()),
    published_by_execution_id: Type.Optional(Type.String()),
  },
  { $id: id("common/output-ref"), title: "Published output reference" },
);
const RunningStage = Type.Object({
  execution_id: nullable(Type.String()),
  stage_id: nullable(Type.String()),
  client: nullable(Type.String()),
  event: Type.String(),
  summary: nullable(Type.String()),
  updated_at: nullable(Type.String()),
});
const SkippedStage = Type.Object({ stage_id: Type.String(), execution_id: Type.String() });

const snapshotProperties = {
  session_id: Type.String(),
  workflow_id: nullable(Type.String()),
  status: Type.String(),
  updated_at: nullable(Type.String()),
  events_cursor: int(),
  execution_id: nullable(Type.String()),
  execution_status: nullable(Type.String()),
  latest_execution_id: nullable(Type.String()),
  latest_execution_status: nullable(Type.String()),
  outcome: nullable(StageOutcomeView),
  questions: Type.Array(SnapshotQuestion),
  outputs: Type.Record(Type.String(), OutputRef),
  outputs_not_produced: strings(),
  running_stages: Type.Array(RunningStage),
  skipped_stages: Type.Array(SkippedStage),
  blocked_by_execution_ids: strings(),
  blocker: nullable(Type.String()),
  baseline: nullable(Type.Object({ commit: nullable(Type.String()), captured_at: Type.String(), error: Type.Optional(Type.String()) })),
  title: Type.Optional(Type.String()),
  handoff: Type.Optional(record()),
  skip: Type.Optional(record()),
  quota_failures: Type.Optional(
    Type.Array(
      Type.Object({
        stage_id: Type.String(),
        execution_id: Type.String(),
        message: nullable(Type.String()),
        reset_at: nullable(Type.String()),
        window: nullable(Type.String()),
      }),
    ),
  ),
  diagnostics: Type.Optional(Type.String()),
  exit_anomalies: Type.Optional(
    Type.Array(
      Type.Object({
        stage_id: Type.String(),
        execution_id: Type.String(),
        turn: Type.Unknown(),
        exit_code: Type.Unknown(),
        accepted: Type.Boolean(),
        count: int(),
        diagnostics: nullable(Type.String()),
      }),
    ),
  ),
};
export const SessionSnapshot = Type.Object(snapshotProperties, { $id: id("cli/session-snapshot"), title: "session show --json" });
export type SessionSnapshot = Static<typeof SessionSnapshot>;
/** The first line of `session follow --json`: the same snapshot, framed as a JSON line. */
export const SessionSnapshotLine = Type.Object(snapshotProperties, { $id: id("cli/session-snapshot-line"), title: "session follow --json first line" });

/** Persisted passthrough: the reader accepts any JSON object. */
export const SessionFollowRecord = Type.Record(Type.String(), Type.Unknown(), {
  $id: id("cli/session-follow-record"),
  title: "session follow --json record line",
  description: "Any JSON object, forwarded from events.jsonl or stream.jsonl. See the known-shape schemas for what a line may look like.",
});
export const SealedMetrics = Type.Record(Type.String(), Type.Unknown(), {
  $id: id("cli/session-metrics"),
  title: "session metrics <id> --json",
  description: "Any JSON object, forwarded from metrics.json. See the known-shape schemas for what a file may look like.",
});
export const SealedMetricsLine = Type.Record(Type.String(), Type.Unknown(), {
  $id: id("cli/session-metrics-line"),
  title: "session metrics --json line",
  description: "One line per sealed session; any JSON object.",
});

export const CancelResult = Type.Object(
  { session_id: Type.String(), cancelled: Type.Boolean(), status: nullable(Type.String()) },
  { $id: id("cli/cancel"), title: "session cancel --json" },
);
export const CompleteResult = Type.Object(
  {
    session_id: Type.String(),
    status: Type.Literal("completed"),
    already_completed: Type.Boolean(),
    outputs: Type.Array(Type.Object({ name: Type.String(), path: Type.String() })),
    missing_outputs: strings(),
    next: Type.Object({ path: nullable(Type.String()), suggestions: Type.Array(NextSuggestion) }),
  },
  { $id: id("cli/complete"), title: "session complete --json" },
);
export const RenameResult = Type.Object(
  {
    session_id: Type.String(),
    title: Type.String(),
    previous_title: nullable(Type.String()),
  },
  { $id: id("cli/rename"), title: "session rename --json" },
);
export const RoleRunResult = Type.Object(
  {
    agent_id: Type.String(),
    options: options(),
    session_id: Type.String(),
    execution_id: Type.String(),
    artifact_directory: Type.String(),
    outcome_status: Type.String(),
    outcome_decision: Type.String(),
    session_status: Type.String(),
    response: Type.String(),
    failure_reason: Type.String(),
    failure_detail: Type.Optional(Type.String()),
    failure_kind: Type.String(),
    reset_at: Type.String(),
    client: Type.String(),
    execution_status: Type.Optional(Type.String()),
    questions: Type.Optional(Type.Array(Question)),
    questions_file: Type.Optional(Type.String()),
  },
  { $id: id("cli/role-run"), title: "session run --role --json" },
);
export const RoleRunResults = listOf(RoleRunResult);
export const PrepareResult = Type.Object(
  { session_id: Type.String(), title: Type.String(), status: Type.Literal("prepared"), task_path: Type.String(), workflow_path: Type.String() },
  { $id: id("cli/prepare"), title: "session prepare" },
);
export const RepairResult = Type.Object(
  { session_id: Type.String(), status: nullable(Type.String()) },
  { $id: id("cli/repair"), title: "session repair" },
);

// ---- service / workspace / update -------------------------------------------------------------

export const ServiceRunning = Type.Object(
  { state: Type.Literal("running"), host: Type.String(), port: int(), pid: int() },
  { $id: id("cli/service-running"), title: "service status --json (running)" },
);
export const ServiceStopped = Type.Object(
  { state: Type.Literal("stopped") },
  { $id: id("cli/service-stopped"), title: "service status --json (stopped)" },
);
export const ServiceStatus = Type.Union([ServiceRunning, ServiceStopped], { $id: id("cli/service-status"), title: "service status --json" });

const workspaceProperties = {
  id: Type.String(),
  name: Type.String(),
  path: Type.String(),
  available: Type.Boolean(),
  registered_at: Type.Optional(Type.String()),
  updated_at: Type.Optional(Type.String()),
  tool: Type.Optional(Type.Object({ name: Type.String(), version: Type.Optional(Type.String()) })),
};
export const WorkspaceRow = Type.Object(workspaceProperties, { $id: id("cli/workspace"), title: "A registered workspace" });
export const WorkspaceList = Type.Object(
  { workspaces: Type.Array(WorkspaceRow) },
  { $id: id("cli/workspace-list"), title: "workspace list --json" },
);
export const WorkspaceMutation = Type.Object(workspaceProperties, {
  $id: id("cli/workspace-mutation"),
  title: "workspace register|remove",
  description: "The registry's workspace record, passed through.",
});
export const UpdateCheck = Type.Object(
  {
    current: Type.String(),
    latest: Type.String(),
    update_available: Type.Boolean(),
    updated: Type.Boolean(),
    command: Type.Optional(Type.String()),
    next: Type.Optional(strings()),
  },
  { $id: id("cli/update"), title: "update --json" },
);
