# Plan: remove the provider abstraction; agents select a CLI client

> Revision 2 answers the review. R1: §5.1 now migrates each config layer separately,
> keeps partial entries, and checks that no agent's client changes. R2: §5.6 now covers
> quota groups that split as well as those that merge. R3: §5.3 now decides an old
> execution's client from recorded evidence and refuses to resume when there is none.
> §2, §3.3, §6, §7, §8, and §9 are updated to match.

## 1. Goal, scope, acceptance

**Goal.** An agent is `{ model, effort?, client: { type, options? } }`. Runtime resolves
`client.type` through one client registry. `ProviderBase`, the provider subclasses, the
provider maps, and `ProviderResolver` are removed. Old configuration migrates
deterministically. Old sessions stay readable through a single legacy-read module, and
old sessions that can be resumed still resume.

**In scope.** Adapter and kernel contracts, config resolution and schema, migration, the
runner, session persistence and readers, quota grouping, metrics, doctor, the CLI
(`init`, `session run --role`, `get`, `config` authoring, `migrate`, `skill`), templates,
docs, bundled skill references, tests, and fixtures.

**Out of scope.** New clients, price catalogs or cost reconciliation, renaming persisted
event kinds or failure vocabulary (§5.4), renaming internal process helpers that the
change does not touch (`spawnProvider`, `renderProviderPrompt`, `provider_pid`;
§5.5), and any change to workflows, routing, verification, or effort semantics.

**Acceptance criteria.** These are the task's criteria, restated so they can be tested.
1. `client.type` + `model` is enough to run every client (`agy`, `claude-code`, `codex`,
   `grok`, `opencode`). `agent.provider` in a current document is rejected with a
   migration hint.
2. `packages/adapters/src/providers/` no longer exists. The kernel has no `Provider`,
   `ProviderInfo`, `ProviderResolver`, `createProviderResolver`, or stub
   `CodexProvider`/`GrokProvider`. `defaultProviders`/`providerMap` are gone.
3. Model strings pass through byte-for-byte, including `router/alias`, `openai/gpt-5`, and
   `model#variant`.
4. Defaults, option validation and persistence, discovery, new and resumed sessions,
   interruption, failure origin and kind, usage capture, deltas, and cost behave as
   before for each client. Each intentional difference is listed in §6.
5. `migent migrate` rewrites v5 config, local config, and workflows to v6. It keeps every
   explicit `client.type`, model, and option, and fails with a named field and the valid
   client IDs when a client cannot be determined.
6. Legacy sessions can be inspected. Resume follows the matrix in §5.3.
7. CLI help, doctor output, `get`, templates, docs, and skill references describe one
   client-based model. The word "provider" remains only at the boundaries listed in
   §5.4 and §5.5.
8. `pnpm build` and `pnpm test` pass and are compared with a baseline taken before any
   change (§8).

## 2. Repository evidence (current state)

| Area | Evidence | Consequence |
| --- | --- | --- |
| Provider classes | `adapters/src/providers/*.ts`: `agy`, `opencode`, `codex`, and `grok` only bind a default client. Codex and Grok also carry v0→v1 "thinking" migrations. `claude` adds `permission_mode=bypassPermissions` by default, a `randomUUID()` session ID, and `modelCatalogInput`. `byteplus` has no client. | Each behavior has a natural owner (§4). |
| `ProviderBase` | Delegates to the client, and adds `profileOptions` (overridable metadata), `classifyFailure` (RawFailure→quota/provider), `normalizeUsage` (cumulative deltas), and a per-run event parser **stored on the shared instance**. | The policy moves to kernel functions. The shared parser state is a latent bug when concurrent stages use the same provider. |
| Duplicated contracts | `adapters/src/types.ts` mirrors `kernel/src/provider-contract.ts` and `kernel/src/cli-client.ts` (adapters has no dependencies on purpose). | Keep one canonical kernel contract. The adapters keep a structural mirror, and the CLI wiring checks it at compile time. |
| Config | `kernel/src/config.ts`: `StageTarget {provider, model, options, client?}`. `loadAgentDefinition` requires `provider`. Effort resolves through `resolveProvider(provider, client).effortOption`. `resolveEffectiveProvider` returns `provider-unsupported`/`client-required`/`client-unsupported`/`options-invalid`. | `StageTarget` becomes `{client, model, options}`. |
| Runner | `agent-runner.ts`: `providers[request.provider]` → `withClient`, `validateSessionProfile(provider, model, options)`, CLI version cache keyed by provider. `continueCancelled` reads only `metadata.provider` and **ignores the client**. | `continueCancelled` already fails for non-default clients today (§6). |
| Persistence | `execution.json`, `conversation.json`, `execution.started`, turn events, and `RunResult` carry `provider` and **never `client`**. Frozen `targets.<stage>` carry `provider` and an optional `client` (freeze `schema_version: 1`). | Readers must map legacy provider IDs to client IDs. Byteplus executions record no client. |
| Quota | `execute.ts` (`parked`, `acted`, `providerOf`, `quotaStep`, `waitFromStage`) and `cli/src/commands/agent.ts` (`waitedUntil`) group quota waits by **provider string**. | A client key is needed (§5.6). |
| Metrics | `metrics.ts` `normalizeTurns` looks up `providers[provider].normalizeUsage`. Byteplus turns therefore normalize to blank, because the client getter throws. A claude provider on a non-claude client would read usage with the wrong parser. | Normalizing by recorded client is more correct (§6). |
| Role runs | `cli/src/commands/agent.ts` calls `runner.run({ provider, model, options, … })` without `client`. | Legacy role executions ran the provider's own client: this is provenance by code path (§5.3). Honoring `client.type` changes behavior (§6.5). |
| Turn evidence | Turn events record `argv: spec.argv` (`agent-runner.ts:1057`). `metrics.ts:388` reads it back. | `argv[0]` is recorded proof of which executable ran (§5.3). |
| Migration | `migration.ts` takes `MigrationProvider` tables from the CLI (`providerMap()`). `migration-config.ts` performs the v4→v5 lift. `migrateConfig` already receives the merged `context`. | The v0 tables move into the migration subsystem, and v5→v6 is added there. |
| CLI | `--provider/--model` on `session run --role`; `--{planner,reviewer,developer}-provider` and `--provider` on `init`; `get providers`; `config-edit.ts` agent writes; `skill.ts` `providerClient`; `cli/src/provider.ts` `providerMap`, `requireProvider`, `detected`. | All of these move to `--client`. |
| Doctor | `doctor/src/providers.ts`, `config-check.ts`, `model-check.ts`, `effort-check.ts`, `authoring.ts`, and `selection.ts` resolve through the provider map. `catalog.ts` already adapts a raw `CliClient` into a `CatalogSource`. | Doctor resolves clients directly. |
| Version | `SCHEMA_VERSION = 5` in `kernel/src/workflow.ts`, shared by config and workflow documents. `EXECUTION_SCHEMA_VERSION = 1`. | Both are bumped (§5.1, §5.2). |

## 3. Target architecture

```
cli (composition root)
  └─ builds ClientRegistry from @nodeint/migent-adapters (createClient/clientIds)
       ├─ kernel: AgentToolRunner(registry), config resolution, migration, metrics, execute
       └─ doctor: catalog/model/effort checks over registry clients
adapters: CliClient implementations + registry (no policy, no provider)
kernel:   runner-facing CliClient contract + shared policy functions + legacy-read boundary
```

### 3.1 Contracts (kernel is canonical)

- **`CliClient`** (`kernel/src/cli-client.ts`, already present) becomes the only
  runner-facing execution contract. It absorbs the types that `provider-contract.ts`
  still owns (`BuildCommandInput`, `TurnUsage`, `UsageCapture`, `FailureClassification`,
  `FailureOrigin`, `ResponseSource`, `InterruptOutcome`, `NewSession`, and the
  option-metadata type renamed `ClientOption`). `provider-contract.ts` is deleted.
- **`ClientInfo`** is a narrow subset (`id`, `command`, `effortOption?`, `options()`,
  `validateOptions`) for config resolution and doctor. It replaces `ProviderInfo`. It
  has no `requiresClient` and no `withClient`.
- **`ClientRegistry`** has `ids(): string[]` and `get(id): CliClient`. `get` throws a
  `ConfigurationError` that names the supported IDs. It replaces `ProviderResolver` and
  `createProviderResolver`, and it is the only selection entry point. The kernel defines
  only the interface. The CLI builds it from the adapters `createClient`/`clientIds`, so
  `tsc` verifies that adapter clients satisfy the kernel contract structurally. This
  replaces today's hand-kept mirror check.
- **`adapters/src/types.ts`** keeps the structural mirror of `CliClient` plus the
  adapter-only discovery surface (`optionsCommand`, `parseOptions`, `HeadlessOption`).
  `Provider`, `ProviderInfo`, and `ProviderResolver` are removed. `STATUS_PROVIDER_EVENTS`,
  `classifyProviderError`, and `providerErrorMessage` stay. They concern the event
  vocabulary of §5.4, not provider selection.
- **Registry location.** `clientFactories`, `createClient`, and `clientIds` move from
  `providers/provider-base.ts` to a new `adapters/src/clients/registry.ts`. Clients are
  created per resolution, so no parser state is shared.

### 3.2 Ownership of relocated behavior

| Behavior (today) | New owner |
| --- | --- |
| Claude `permission_mode` default `bypassPermissions` | `ClaudeCodeClient.runCommand`: an execution default applied when the option is unset, never persisted (same as today). |
| Claude `randomUUID()` session ID | `ClaudeCodeClient.newSessionId()`. The client already emits `--session-id` for `newAgentId`. |
| Claude `modelCatalogInput` | Already expressed by `ClaudeCodeClient.modelsCommand().stdin`. Doctor's `catalog.ts` uses it. Nothing to move. |
| `profileOptions` (overridable options persisted in the session) | Kernel function `sessionOptions(client, options)` in a new `kernel/src/client-policy.ts`, driven by `client.options()` metadata. |
| `classifyFailure` (RawFailure → quota/provider + messages) | `client-policy.ts` `classifyFailure(client, stdout, exitCode)`. The runner's `classifyFinishedProcess` keeps the `start`/fallback rules. Messages and origins are unchanged. |
| `normalizeUsage` (cumulative deltas, null on missing or negative) | `client-policy.ts` `normalizeUsage(client, current, previous)`. Used by `metrics.ts`. |
| Per-run event parser | The runner calls `client.createEventParser()` once per turn and passes it through the turn loop. Nothing is stored on a shared instance. |
| Codex/Grok v0 "thinking" migrations | Migration subsystem: `kernel/src/migration-legacy.ts`, keyed by **legacy provider ID**, with the native option names fixed as historical constants. |
| Process execution, retry, quota waits, persistence | Remain in the kernel, now keyed by client (§5.6). |

### 3.3 Legacy-read boundary (one module)

`kernel/src/legacy-provider.ts` is the **only** place where provider IDs are interpreted
after the refactor. It holds:

- `LEGACY_PROVIDER_CLIENT`: `agy→agy`, `claude→claude-code`, `codex→codex`, `grok→grok`,
  `opencode→opencode`, `byteplus→null`. This is a fixed historical table, deliberately
  independent of the live adapter registry.
- `legacyClientOf(provider): string | null`. Used **only** for configuration
  migration (§5.1), for normalizing frozen targets when checking drift, and for the
  role-session `code-path` provenance. It is never used on its own to choose a client
  for a workflow execution.
- `LEGACY_COMMAND_CLIENT` (`claude`→`claude-code`, `codex`, `grok`, `opencode`, `agy`) and
  `legacyExecutionClient(execution)`. This is the provenance policy of §5.3, shared by
  resume, metrics, and quota keys.
- The v0 migration tables (§3.2). These could instead live in `migration-legacy.ts` and
  import the table from here; either way they stay in the kernel.

Consumers are migration, the frozen-target reader, the execution and conversation
readers, the event and status fold, metrics, quota grouping, and the CLI role-session
resume reader. No execution path takes a provider ID as input.

## 4. Configuration and CLI surface

### 4.1 Agent shape (schema_version 6)

```yaml
agent:
  model: router/model-alias   # opaque client-facing string
  effort: high                # optional alias → client.effortOption
  client:
    type: opencode            # required
    options: {}               # optional
```

- The same shape applies to named agents, inline role agents, inline stage agents, and
  local overrides. Merge rules are unchanged: named agents merge key by key, and role or
  stage agents replace the whole agent.
- `client.type` is required on the **effective** (merged) agent. A local named-agent entry
  may omit it and inherit it from the shared entry, as `model` can today.
- `provider` in a v6 agent produces `legacy-key`: `<field>.provider was removed in
  schema_version 6; set <field>.client.type. Run \`migent migrate\`.`
- Effort resolution uses `registry.get(client.type).effortOption`. The conflict and
  unsupported rules are unchanged.
- Failure codes: `client-required` (no `client.type`), `client-unsupported` (unknown ID),
  and `options-invalid`. `provider-unsupported` is removed. Doctor's `failurePath`
  becomes `client.type` / `client.options`.
- `resolveEffectiveProvider` becomes `resolveEffectiveClient`, and
  `EffectiveProviderFailure` becomes `EffectiveClientFailure`.

### 4.2 CLI

| Surface | New | Old input |
| --- | --- | --- |
| `session run --role` | `--client <id> --model <m>` (both or neither) | `--provider` errors with: "removed; use --client <id> (claude→claude-code, …)". The flag stays registered but hidden, only so it can produce this error. |
| `init` | `--{planner,reviewer,developer}-client`, `--client` (alias for developer). Interactive mode lists models from installed **clients**. | The `*-provider` flags error the same way. |
| `get` | `clients`, `models`, `options`, `efforts` (keyed by client, as today) | `get provider(s)` errors with "use `migent get clients`". The `provider list` stub stays removed. |
| `config` authoring (`config-edit.ts`) | Agent writes take `client` and `model` | — |
| Display strings | `client/model` in notices, `failure.md`, and quota lines. The `get agents` and `get roles` columns become `CLIENT`/`MODEL`. | — |
| `migrate` | Adds the v5→v6 step. Stops passing `providerMap()`. | — |
| `skill` | `clientsFromConfig` reads `client.type` only. `providerClient` is removed. | — |

## 5. Compatibility decisions

### 5.1 Document schema: bump to 6 (config, local config, workflows)

`SCHEMA_VERSION` is shared, so every workflow is bumped as well. Most workflows need only
the version line. Workflows with inline stage agents are rewritten. Current commands
already stop on older documents and point to `migent migrate`, so v6 never has to parse
`provider`.

**Migration works layer by layer and preserves partial documents.** Two facts fix
the design. First, `config.yaml` is committed and used alone on machines that have no
local file. Second, `config.local.yaml` is merged over it: named agents merge key by key,
and role agents replace the whole agent (`config.ts` `mergeConfigLayers`). So each layer
is migrated against the configuration that is in effect wherever that layer applies.
Every decision uses the **original v5 documents**: the context that `migrate.ts` loads
before it rewrites anything (`loadWorkspaceConfig`, line 123). It never uses a layer
that has already been migrated.

*Definitions.* A **location** is one place an agent is defined: `agents.<n>`,
`roles.<r>.agent` (when it is a mapping), or `stages[].agent` (when it is a mapping).
The **v5 effective client** of a location in a given configuration is the explicit
`client.type` of the merged body if it has one, otherwise
`legacyClientOf(merged provider)`. It is *undetermined* when the merged body has no
provider and no `client.type`, and *unresolvable* when the provider is `byteplus` or
unknown and there is no `client.type`.

*Rules applied to each body that a layer contains:*

| Body in this layer | Project layer (context = project alone) | Local layer (context = original merged project + local) |
| --- | --- | --- |
| `provider` + `client.type` | Drop `provider`. | Drop `provider`. |
| `provider`, no `client.type` (a `client.options`-only mapping counts as no `client.type`), effective client resolvable | Write `client.type` = the v5 effective client in this context, then drop `provider`. | Named entry: drop `provider`. Write `client.type` in the local layer **only when** the merged body has no explicit `client.type` from either layer, because only then does the local provider decide the client. Role agent (replaced whole): same as the project layer. |
| `provider`, no `client.type`, unresolvable here, but another layer supplies `client.type` for the same location in the merged view | Drop `provider` and write nothing. The project body stays partial, as it effectively was. The note says it still needs a client wherever no local file supplies one. | Not applicable: the merged view already has a client. |
| `provider`, no `client.type`, unresolvable in every view | **Fail.** Name the field and list `clientIds()`, for example `agents.x: provider byteplus has no default client; add agents.x.client.type (one of: …) and rerun migrate.` | Fail in the same way. |
| No `provider` (a placeholder `{}`, a `model` only, `client.options` only, `effort` only) | Keep it unchanged. It is a partial layer. | Keep it unchanged. |

*Who writes a synthesized client.* A `client.type` that was not in the documents is
written into the layer that supplied the `provider` it comes from. It is never added to
the other layer, so machine-local choices stay in the local file and shared choices stay
shared.

*Worked cases (they become tests):*
- shared `x: {}` and local `x: {provider: codex, model: m}`: shared stays `{}`, local
  gains `client.type: codex`.
- shared `x: {provider: claude, model: m}` and local `x: {client: {options: {k: v}}}`:
  shared gains `client.type: claude-code`, local is unchanged, merged gives
  `claude-code` + `k`.
- shared `x: {provider: claude}` and local `x: {provider: codex}`: shared gains
  `claude-code`, local gains `codex`, merged gives `codex` (as in v5).
- shared `x: {provider: claude, client: {type: opencode}}` and local `x: {provider: codex}`:
  local only drops `provider`, merged stays `opencode` (in v5 the explicit client won).
- shared `x: {provider: byteplus}` and local `x: {client: {type: opencode}}`: shared drops
  `provider` and stays partial; the note says it is incomplete without the local file.

*Undetermined locations* (no provider or client in any layer) were already invalid in
v5. Migration leaves them unchanged and does not fail. Doctor and config validation then
report `client-required`, as they reported the missing provider before.

*Equivalence guard.* After the rewrite, migration recomputes the effective client of
every location in two views: project alone, and project merged with local. Each must
equal the v5 effective client, or stay undetermined where it was undetermined or
unresolvable before. Any difference aborts the write, in the same way
`assertMigratedWorkflow` guards workflows today.

*Workflows.* Inline stage agents replace the whole agent and are committed with the
workflow, so they follow the project-layer rules. Named stage references are not
changed.

Model, effort, options, comments, and key order are preserved by the existing text
patchers. Model strings are never parsed. The v0 "thinking" migrations still run for
versions below 1, keyed by legacy provider through `migration-legacy.ts`. Notes such as
`agents.x.provider codex -> client.type codex` and `agents.x.provider dropped (client
from config.local.yaml)` join the existing migrate notes.

### 5.2 Runtime persisted formats (new writes)

| Record | New field | Version |
| --- | --- | --- |
| `execution.json` | `client` (no `provider`) | `EXECUTION_SCHEMA_VERSION` 1→2 |
| `conversation.json` (`AgentSessionRecord`) | `client` | Unversioned. The reader accepts either field. |
| `execution.started` and turn event data, `ProviderEvent` payload, `RunResult`, `runResultJson`, status fold `stages.<id>` | `client` | Event envelope `v` is unchanged. Fields are additive for readers. |
| `workflow.frozen.yaml` `targets.<stage>` | `{client, model, options}` | freeze `schema_version` 1→2 |
| `metrics.json` per-execution rows | `client` replaces `provider` | Only newly sealed files. Existing files are never rewritten. |

Immutable history is not rewritten. Old files are normalized **at read time** through
`legacyClientOf`. Status snapshots are re-folded from events as they are today, so stage
entries gain `client` from the normalized events.

### 5.3 Legacy execution provenance and resume

A provider with a default client does **not** prove that its default client ran a given
historical conversation. Workflow dispatch passed `target.client` to the runner
(`dispatch.ts:116`), but `execution.json` and `conversation.json` never recorded it. So
the client of a legacy execution has to come from recorded evidence, not from the
mapping alone.

`legacy-provider.ts` therefore exposes one function, `legacyExecutionClient(execution)`.
It returns `{ client, provenance }` or `{ client: null, reason }`. Resume, cancelled
continuation, role-session resume, metrics usage parsing, and quota keys all use it, so
all of them apply the same policy.

**Evidence, strongest first:**

| Provenance | Source | Why it is reliable |
| --- | --- | --- |
| `recorded` | The `client` field of `execution.json` (new records). | Written by the runner. |
| `executable` | `argv[0]` of the execution's turn events (`provider.turn_completed` / `provider.turn_failed` details carry `argv: spec.argv`, `agent-runner.ts:1057`). Mapped through a fixed historical **command→client** table: `claude`→`claude-code`, `codex`, `grok`, `opencode`, `agy`. | It is the executable Migent actually launched. Every client has a distinct command. It comes from the record, not from the model string. |
| `code-path` | A role-session execution (`session run --role`, `cli/src/commands/agent.ts`). Those runs never passed `client` to `runner.run` (lines 108–117 and the other calls), so the runner always used the provider's own client. Mapped through `legacyClientOf(provider)`. | Determined by the code that created the record. |

**Evidence that is deliberately not used for resume:**
- The frozen target. `--refresh` can rewrite `workflow.frozen.yaml` after the execution
  ran (`refreshSessionWorkflow`), and freeze-less sessions are still supported.
- `legacyClientOf(provider)` for workflow executions. It is a guess whenever a client
  override could have been active.

A frozen target may only *corroborate* other evidence. When it names a different client
than the `executable` evidence, the execution is treated as conflicting.

**Outcomes:**
- **Exactly one client from the evidence** (`recorded`, `executable`, or `code-path`), with
  no conflict: resume and continue with that client, the native `agent_id`, the model
  string, and the options. The session check compares `client, model, sessionOptions`.
- **Conflict** (for example `executable` ≠ the frozen target's client, or ≠ the `client`
  the caller requested): resume is refused. The error names both clients and says to
  start a new attempt. Native conversation IDs are never sent to a different CLI.
- **No evidence** (a legacy workflow execution with no turn event: it was cancelled or
  failed before the first process finished, or turn events are missing): resume is
  refused with `cannot determine which CLI ran execution <id>; start a new attempt`. No
  native conversation can be confirmed, so nothing is lost beyond the earlier prompt.
  The stage can be rerun.

**Matrix:**

| Legacy case | Inspect (`show`, `follow`, doctor session, `metrics`) | Resume / continue | Usage parsing for unsealed metrics |
| --- | --- | --- | --- |
| Workflow execution with turn events (any provider, freeze or not, default client or override) | yes | yes, with the `executable` client | `executable` client |
| Workflow execution with no turn events | yes | **refused** (no evidence) | no capture exists, so nothing to parse |
| Workflow execution whose evidence conflicts | yes | **refused** | the `executable` client, which is the launched CLI's own output format |
| Role session, default-client provider | yes | yes (`code-path`) | `code-path` client |
| Role session, `byteplus` | yes | **refused**. These runs could never start, because `ByteplusProvider` had no client. | n/a |
| Sealed `metrics.json` | printed verbatim (keeps `provider`) | n/a | never recomputed |

Limitations to disclose in `docs/sessions.md`:
1. Legacy workflow executions with no recorded turn cannot be resumed in place.
2. Legacy records written before turn events carried `argv` are treated as having no
   evidence. Event `v:2` has carried `argv` since turn events were introduced; the
   developer confirms this against the event history while writing the fixtures.
3. Unsealed legacy metrics now parse usage with the launched client. Before, the
   provider's default parser was used, which was wrong for client overrides. Turns with
   no evidence stay `uncaptured`, never zero.

### 5.4 Historical names that are kept (persisted vocabulary)

These names are kept and documented as compatibility boundaries, because renaming them
would break existing logs, status consumers, the registry UI, and user tooling. Their
meaning is restated as "the agent CLI":

- event kinds `provider.*` (`STATUS_PROVIDER_EVENTS`, `provider.exit_anomaly`, …)
- `failure_kind: "provider"`, `FailureOrigin "provider-error"`, `ProviderClassification`.
  The last is a kernel type name and may be renamed `CliFailure` if the developer
  prefers, but its JSON value stays the same.
- `execution.json` `provider_pid` / `provider_endpoint` (process ownership)
- the legacy `provider` field in old records, read only by §3.3

### 5.5 Internal names not renamed

`spawnProvider*`, `renderProviderPrompt`, `ProviderEventReporter`, `provider-interrupt.ts`,
and `provider-spawn.ts` are process and prompt helpers, not selection. Renaming them is
churn with no behavior change. They stay unless an edit already touches them. This is
listed so a reviewer can decide whether to require it.

### 5.6 Quota and concurrency grouping

Today quota parking (`execute.ts` `providerOf`, `parked`, `acted`, `quotaStep`) and
role-session waits (`agent.ts` `waitedUntil`) are keyed by the **provider string**,
whatever client actually ran (`execute.ts:894` reads `target.provider`, while dispatch
runs `target.client`). After the refactor no provider exists, so the key becomes the
**client ID**. Quota waits recorded before the upgrade (legacy status or results without
`client`) take their key from `legacyExecutionClient` (§5.3). When there is no evidence,
the key is `"legacy:" + provider`, so an old wait never silently joins another group.

The change works in **both directions**:

| Configuration | Today (provider key) | After (client key) | Effect |
| --- | --- | --- | --- |
| `claude` and `byteplus` stages, both on `claude-code` | 2 groups | 1 group | **Merge.** A quota on one delays the other until the reset. |
| `byteplus` stages on `opencode` and on `claude-code` | 1 group | 2 groups | **Split.** While one waits, the other keeps running. If both reach the same backend account, the second one fails with its own quota and then parks. |
| A default-client provider with an explicit override on some stages (for example `codex` on `codex` plus `codex` on `opencode`) | 1 group | 2 groups | **Split**, with the same consequence. |
| `opencode` stages behind different router aliases | 1 group | 1 group | Unchanged. |
| One client and one provider (the common setup) | 1 group | 1 group | Unchanged. |

Neither key reflects the real limit. The real limit is an account or backend, which
Migent cannot see, and a model string cannot reliably reveal it (router aliases, the
namespaces opencode uses). This plan keeps the client key because it is the only
selector left, and it is accurate for the common setup where one client means one
account.

The cost of a wrong split is bounded by existing rules. Each group pays at most one
extra failed turn per reset window: the second group hits the limit, gets classified as
`quota`, and parks. The `acted` rule (`quotaStep`: the same or an earlier reset stops
the loop) still prevents repeated retries. A wrong merge only delays work and never
causes extra failures.

Two alternatives were rejected:
- `(client, model)` adds further splits for account-level limits.
- An explicit quota-group setting would be a new feature, which is out of scope. It is
  the natural follow-up if mixed-client setups need shared limits, and should be
  recorded in `docs/backlogs.md` only with user approval.

The `docs/workflows.md` concurrency section will document both the merge and the split
cases.

## 6. Intentional behavior differences

1. **Claude-code defaults now follow the client.** `byteplus` + `claude-code` now gets
   `permission_mode=bypassPermissions` and a Migent-generated session ID, as `claude` did.
   This is a **permission-relevant broadening** for those users and needs explicit
   approval. Conversely, `claude` + a non-claude client no longer injects a stray
   `permission_mode` (codex used to receive `-c permission_mode=…`).
2. **Metrics read usage with the recorded client's parser**, not the provider's default
   client. This fixes wrong or blank usage for non-default clients in new sessions.
   Legacy byteplus turns stay blank, as they are today.
3. `continueCancelled` honors the client (§5.3).
4. Quota grouping by client: some groups merge and others split (§5.6).
5. **Role sessions honor `client.type`.** Today `session run --role` never passes the
   configured client to the runner (`cli/src/commands/agent.ts`), so role runs silently
   use the provider's own client. After the refactor they run the configured client, the
   same as workflow stages. Users who set a client override and relied on role runs
   ignoring it will see a different CLI.
6. Legacy resume is refused when no execution evidence exists or the evidence
   conflicts (§5.3). Before, such cases could silently resume on a guessed CLI.
7. CLI flags and `get providers` are removed with migration errors (§4.2). This is a
   breaking CLI change and needs a CHANGELOG entry (release skill scope, not this change).

## 7. Dependency-ordered change sequence

Each step leaves `pnpm build` green. Tests are updated in the same step as their code.

1. **Baseline.** Run the commands in §8 on a clean `next` and record the results. Stop on
   any failure.
2. **Kernel contracts.** Consolidate the types into `cli-client.ts`, and add
   `ClientRegistry`, `ClientInfo`, `client-policy.ts`, and `legacy-provider.ts`. Keep
   `provider-contract.ts` temporarily as re-exports, only so the step builds.
3. **Adapters.** Add `clients/registry.ts`. Move the Claude defaults into
   `ClaudeCodeClient`. Remove `providers/`, `defaultProviders`, and `providerCommands`.
   Update `index.ts` and `types.ts`. Convert the `*-provider.test.ts` files into client
   tests that reuse the existing fixtures.
4. **Config resolution.** `StageTarget {client, model, options}`, `loadAgentDefinition`
   (client required, provider rejected), effort through the registry,
   `resolveEffectiveClient`, `SCHEMA_VERSION = 6`, and views and `config-edit.ts`.
5. **Migration.** `migration-legacy.ts` (the v0 tables) and the layer-aware v5→v6 lift with the equivalence guard in
   `migration-config.ts` (§5.1). Remove the `MigrationProvider` parameter from
   `migrateConfig` and `migrateWorkflow`.
6. **Persistence and legacy reads.** Freeze v2 writer, and a reader for v1 and v2;
   `execution.json` v2; `AgentSessionRecord.client`; event, fold, and status `client`;
   reader normalization through `legacy-provider.ts`.
7. **Runner and orchestration.** `AgentToolRunner(registry)`, per-turn parser, policy
   functions, client-keyed version cache, `validateSessionProfile` on client,
   `continueCancelled` and resume through `legacyExecutionClient` (§5.3), role runs passing `client`, quota grouping in `execute.ts` and `dispatch.ts`,
   and `RunRequest` and `RunResult` with `client`.
8. **Metrics.** Normalize by client. Execution rows carry `client`.
9. **Doctor.** Resolve through the registry in `config-check`, `model-check`,
   `effort-check`, `authoring`, `selection`, `session`, and `stage-agents`. Delete
   `withTargetClient`.
10. **CLI.** Registry wiring (replacing `provider.ts` `providerMap`, `requireProvider`, and
    `detected`), `init`, `session run --role`, `get` resources, `skill`, `migrate`, and
    the removed-flag errors.
11. **Kernel cleanup.** Delete `provider-contract.ts` and its index exports.
12. **Docs, templates, skill.** Rename `docs/providers.md` to `docs/agents.md` ("Agent
    configuration") and update `docs/README.md` and every link. Rewrite
    `docs/adpaters.md` without the provider layer, update `cli.md`, `sessions.md`,
    `session-metrics.md`, `diagnostics.md`, and `workflows.md` (quota grouping), and
    document the boundaries in §5.4. Update `templates/*` to `schema_version: 6`, and
    `skills/migent/references/{config.md,role-sessions.md,schema-config.yaml,schema-workflow.yaml,setup.md}`.
    Run the existing skill-sync test.
13. **Verification** (§8) and a comparison with the baseline.

## 8. Verification

**Commands** (repository scripts; CI runs the same `pnpm build` + `pnpm test` on three OSes):

```bash
pnpm install --frozen-lockfile
pnpm build                     # tsc -b is the typecheck gate; there is no separate lint script
pnpm test                      # vitest: packages/**/test + integration/
pnpm vitest run packages/adapters/test
pnpm vitest run packages/kernel/test/migration.test.ts packages/kernel/test/config.test.ts \
  packages/kernel/test/session-freeze.test.ts packages/kernel/test/metrics.test.ts \
  packages/kernel/test/agent-runner.test.ts packages/kernel/test/cancel-resume.test.ts
pnpm vitest run packages/cli/test packages/doctor/test integration
# terminology gate (review, not a CI check): remaining matches must fall under §5.4/§5.5
rg -n -i "provider" packages/*/src skills templates docs --glob '!**/legacy-provider.ts'
```

**Required coverage** (captured fixtures and fake binaries only; never a real CLI, per
`CONTRIBUTING.md`):

| Topic | Tests |
| --- | --- |
| Migration | v5→v6 for named, inline role, inline stage, and local agents. Explicit `client.type` takes precedence over the provider default. Each default mapping. Every worked case in §5.1: shared `{}` placeholder, `client.options`-only local entry, provider-only local override with and without an explicit client in either layer, byteplus partial in project with the client in local. Unresolvable byteplus and unknown provider fail with the field and client list. Undetermined locations are left unchanged. The equivalence guard aborts when the effective client would change (verified by injecting a faulty rewrite). v0 thinking moves still apply. Comment and order preservation. Idempotence at v6. |
| Config | `provider` in v6 is rejected. Missing `client.type`, unknown client, effort through the client, effort conflict, and option precedence and whole-agent replacement are unchanged. |
| Model passthrough | `router/alias`, `openai/gpt-5`, and `model#variant` reach argv unchanged. The OpenCode variant and effort rules hold. |
| Clients | New and resumed argv per client. Claude default `permission_mode` (unset, and explicitly set) and its UUID session ID. OpenCode session ID. Interrupt commands. Event parser isolation across two concurrent runs. |
| Failures | `provider-error` vs `exit-only` vs `start` origins. Quota with and without reset. Exit-anomaly acceptance is unchanged (existing `exit-anomaly.test.ts`). |
| Usage | Cumulative deltas (codex, agy), per-process (claude, grok, opencode), opencode `step_finish` cost sum, null on missing or negative, `usage_missing`/`cost_partial` completeness. |
| Legacy sessions | Fixture sessions with freeze v1, execution v1, and provider-only events. Each row of the §5.3 matrix: `executable` provenance with a default client and with an override (for example provider `codex` with `argv[0]=opencode`, in sessions with and without a freeze). Resume, a question reply, and `continueCancelled` use that client and the native ID. No-turn execution → refused. Conflict between `argv` and the frozen target → refused, and nothing is spawned. Role session → `code-path` client. Byteplus role session → refused. Unsealed metrics parse with the evidence client. Sealed metrics are left untouched. Drift check of a v1 freeze against v6 config reports no drift. |
| Quota | Grouping by client. The legacy and evidence-based keys. Both the merge and the split rows from §5.6, including the one-extra-failure bound on a split. |
| Role sessions | `session run --role` launches the configured `client.type` (§6.5). |
| CLI | `--client` flows for `init` and `session run --role`. Removed-flag and `get providers` errors. `get agents` columns. Doctor messages. |

**Live verification (not automatable, paid or authenticated).** Run one real turn and one
resumed turn per installed client (`claude-code`, `codex`, `grok`, `opencode`, `agy`),
including an OpenCode router alias, and check cost capture against a real `step_finish`.
Report these as unverified if they are not performed.

## 9. Risks and open questions

1. **Permission default broadening** (§6.1) needs user approval. The alternative is to
   keep `bypassPermissions` only when migrating from `claude` by writing it into
   `client.options` during migration. That alternative is rejected because it persists a
   default into user config and still diverges per user.
2. **Breaking CLI and schema change.** Every workflow file gets a version bump. Users must
   run `migent migrate`. The error messages carry the mapping.
3. **Quota regrouping in both directions** (§5.6). Merges delay work. Splits can cost
   one extra quota-failed turn per group and reset window when separate clients share
   an account. This is accepted as a limitation; an explicit quota group is a possible
   follow-up that needs approval.
3a. **Legacy resume refusals** (§5.3) for executions with no evidence or conflicting
   evidence. Inspection stays available. Assumption: turn-event `argv[0]` is the bare
   client command that `runCommand` emitted. The developer verifies this with recorded
   fixtures from every client before relying on it.
3b. **Migration layering** (§5.1) depends on the original v5 merged context. The
   equivalence guard turns any mistake in the rules into an aborted write instead of a
   silently changed client.
4. **Structural drift** between `adapters/types.ts` and the kernel contract. This is
   mitigated by having the CLI composition root type the registry against the kernel
   interface.
5. **Size.** The change touches about 60 source files across five packages. The step
   order in §7 keeps each step buildable. A reviewer may prefer two pull requests:
   steps 2–9, then 10–12.
6. **Open:** whether to rename the internal helpers in §5.5 now (recommended: no), and
   whether `metrics.json` rows should also keep `provider: null` for consumers
   (recommended: no; the field is replaced and documented).
