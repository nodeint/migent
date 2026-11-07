# Implementation report: remove the provider abstraction

## Summary

Agents now select a CLI client directly: `{ model, effort?, client: { type, options? } }`.
The provider abstraction, provider subclasses, provider maps, and `ProviderResolver`
are removed. Configuration and workflows migrate to `schema_version: 6`. Legacy
sessions stay readable, and resumable legacy sessions resolve their client from
recorded evidence. Historical event and failure vocabulary is retained where the
plan requires it.

## What changed

### Kernel contracts and config

- Added `cli-client.ts` as the canonical client contract and `client-policy.ts` for
  selection policy. Deleted `provider-contract.ts`.
- `StageTarget` is `{ client, model, options }`. `loadAgentDefinition` requires
  `client.type` and rejects `provider` with:
  `...provider was removed in schema_version 6; set ...client.type. Run \`migent migrate\`.`
- `resolveEffectiveClient` reports `client-required`, `client-unsupported`, and
  `options-invalid` through `EffectiveClientFailure`.
- Model strings pass through unchanged, including `router/alias`,
  `openai/gpt-5`, and `model#variant`.
- Added `legacy-provider.ts` as the single place that interprets legacy provider IDs
  (`legacyClientOf`, `legacyExecutionClient`, `quotaClientKey`), plus
  `migration-legacy.ts` for historical `thinking` migrations.
- `SCHEMA_VERSION` is 6.

### Adapters

- Added `clients/registry.ts` (`clientIds()`, `createClient()`), removed
  `providers/`, `ProviderBase`, provider subclasses, `defaultProviders`, and
  `providerCommands`.
- `ClaudeCodeClient` owns the `permission_mode=bypassPermissions` default and the
  generated session ID.
- Provider test files are now client tests; adapters tests pass.

### Runner, persistence, and resume

- Runner resolves the client through the registry, keeps per-turn parsers, and keys
  the version cache by client.
- `execution.json` schema is 2 and writes `client`. Freeze schema 2 writes the
  resolved target as `client`/`model`/`options`.
- Session fold and repair now carry `client` (execution records, running stages,
  and repaired `execution.started` events). Legacy `provider` reads go through
  `legacy-provider.ts`.
- Resume and continue use the §5.3 evidence policy: recorded client, then turn-event
  `argv[0]`, then the role-session code path. Conflicting or missing evidence is
  refused with `Cannot resume execution <id>: <reason>. Start a new attempt.`
  and nothing is spawned.
- Metrics rows carry `client`; unsealed legacy usage is parsed with the launched
  client, sealed `metrics.json` is untouched.
- Quota waits are keyed by client ID, with legacy/evidence fallback keys.

### Migration

- `migrateConfig` and `migrateWorkflow` are layer-aware. Each config layer is lifted
  against the original merged v5 context, so a client is synthesized only in the
  layer that supplied the legacy provider. Partial entries are preserved.
- `assertConfigClientEquivalence` aborts if project-alone and merged views would
  resolve differently.
- Default mappings: `claude→claude-code`, `codex→codex`, `grok→grok`, `agy→agy`,
  `opencode→opencode`. `byteplus` has no default and must name a client.
- Workflows migrate stage `options` away and `model` to `agent`, with notes.

### Doctor and CLI

- Doctor resolves clients through the registry and exposes a `clients` check.
- CLI composition root is `packages/cli/src/client.ts`. Renames include
  `provider.ts`→`client.ts`, `providerMap`→`clientRegistry`,
  `runProviderCommand*`→`runClientCommand*`, and `get providers` removal.
- `init`, `session run --role`, `get`, `config` authoring, `migrate`, and `skill`
  accept/emit client terms. Removed flags fail with `--client` mapping hints.
- Templates and repository `.migent` config/workflows are at `schema_version: 6`.

### Docs and skill references

- `docs/providers.md` is now `docs/agents.md`; links and terminology are updated.
- Updated `docs/README.md`, `docs/adpaters.md`, `docs/cli.md`, `docs/sessions.md`,
  `docs/session-metrics.md`, `docs/diagnostics.md`, `docs/workflows.md`,
  `docs/human-in-the-loop.md`, `docs/backlogs.md`, `README.md`, and
  `CONTRIBUTING.md`. Historical event names, failure kinds, and wrapper messages
  are kept verbatim.
- Updated skill references: `config.md`, `role-sessions.md`, `schema-config.yaml`,
  `schema-workflow.yaml`, `setup.md`, and `workflow-results.md`.
- Added the legacy-session limitations from §5.3 to `docs/sessions.md`, including
  the no-evidence and conflicting-evidence refusals.

## Verification

Commands run from the repository root with Git `bin` on `PATH`:

```bash
pnpm build
pnpm test
pnpm vitest run packages/kernel/test/session-fold.test.ts
pnpm vitest run packages/cli/test/schema.test.ts packages/cli/test/skill-sync.test.ts
pnpm migent migrate --yes
pnpm migent doctor
```

Results:

- `pnpm build`: passed (`tsc -b` and template copy).
- `pnpm test`: passed, 111 files, **1245 passed, 3 skipped**. The pre-existing
  Windows failures without Git `bin` on `PATH` did not appear.
- Targeted fold/schema/skill-sync tests: passed.
- Repository migration: `.migent/config.yaml`, `.migent/config.local.yaml`, and
  both workflows migrated to `schema_version: 6`. Per-layer notes matched the
  expected provider-to-client mappings; local `developer` kept `opencode`.
- `pnpm migent doctor`: `config ok`, `workflows ok`, `clients ok` (for the three
  installed CLIs), `skill ok`. The only warnings were that globally installed
  skill copies differ from the bundled one, which is outside this change.

## Terminology gate review

The reviewed `provider` matches in source, docs, and skill references are all
intentional:

- historical event kinds such as `provider.exit_anomaly`, `provider.turn_completed`,
  and `provider.heartbeat`;
- persisted failure vocabulary: `failure_kind: "provider"`,
  `ProviderClassification`, `provider-error`, and `provider-exit`;
- process ownership fields and internal helper names such as `provider_pid`,
  `spawnProvider*`, `renderProviderPrompt`, `ProviderEventReporter`,
  `provider-interrupt.ts`, and `provider-spawn.ts`;
- legacy reads in `legacy-provider.ts` and the migration modules;
- exact user-visible wrapper messages and OpenCode's `provider/model` model format;
- removed-command and removed-flag error text.

No selection-layer provider abstraction remains.

## Intentional behavior differences

- Claude defaults now follow `claude-code`, including for models that used to name
  another provider.
- Role sessions honor the configured `client.type`.
- Quota grouping is by client ID; the §5.6 merge and split cases are documented.

## Not verified

- Live turns and resumed turns against real `claude-code`, `codex`, `grok`,
  `opencode`, and `agy` CLIs were not performed. In particular, real cost capture
  from an OpenCode `step_finish` is unverified. All automated coverage uses fake
  binaries and captured fixtures, per `CONTRIBUTING.md`.

## Risks and notes

- This is a breaking schema and CLI change. Every workflow file needs
  `schema_version: 6`, and users must run `migent migrate`.
- Legacy executions with no turn event, or with conflicting client evidence,
  cannot be resumed in place. Inspection still works, and the stage can be rerun.
- Quota grouping by client can split or merge waits compared with the old provider
  key; the bounded cost is documented in `docs/workflows.md`.
