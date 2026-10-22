# Plan v2: Split client from provider

Supersedes nothing: `client-provider-split.md` is left as is. This document restates the same goal with explicit contracts, a step order that keeps old behavior until the last step, and an acceptance check per step.

## 1. Goal and trigger

A **client** is the CLI migent spawns. A **provider** is the backend that owns the model and its failures. Today `provider` in config names the client, so a client that fronts several backends cannot be classified correctly.

Trigger: the `implement` stage of session `b16e453e-90c7-4675-9023-38566e3e20b7` ran `opencode` with `coding-plan/dola-seed-2.0-code`. BytePlus answered:

```
You have exceeded the 5-hour usage quota. It will reset at 2026-10-22 18:43:08 +0800 CST.
```

The opencode adapter returned `kind: "provider"`, so no reset time was recorded and no wait was scheduled. Only `ClaudeAdapter` can return `kind: "quota"` today.

Goal: any client can run against any backend, and quota handling depends on the provider, not on which client ran.

## 2. Terms and naming rules

- **Client id** and **provider id** are two independent namespaces. The same string may appear in both (`opencode`). No rule says they must match or must differ.
- Client ids: `claude-code`, `codex`, `grok`, `agy`, `opencode`.
- Provider ids: `claude`, `codex`, `grok`, `agy`, `opencode`, `byteplus`.
- **Default client table** (data, one place, edited freely):

  | provider | default client |
  | --- | --- |
  | `claude` | `claude-code` |
  | `codex` | `codex` |
  | `grok` | `grok` |
  | `agy` | `agy` |
  | `opencode` | `opencode` |
  | `byteplus` | none: `client` is required |

- `model` is the string handed to the client. Migent never infers the provider from it and never rewrites a config entry.

## 3. Data model

### 3.1 Stage target

`{ client?, provider, model, options }`. `provider` keeps its key and its event field name and now means the backend. `client` is new and optional in input; after resolution it is always set.

Resolver `resolveClient(target) -> clientId`:
1. `target.client` if present.
2. Else the default table entry for `target.provider`.
3. Else a configuration error naming the provider: `Provider "X" has no default client; set "client".`

The same resolver is used by config loading, overrides, frozen session targets, resume, metrics and doctor. There is no second path for old data. A stored target or execution record without `client` goes through step 2.

### 3.2 Failure types

```ts
interface RawFailure {
  message: string | null;     // text the client extracted from the run
  exitCode: number | null;
  rateLimit?: {               // set only when the client's protocol states it structurally
    resetAt: string | null;   // absolute UTC ISO 8601
    window: string | null;    // e.g. "5h"
  };
}

interface ProviderProfile {
  readonly id: string;
  classify(raw: RawFailure): FailureClassification | null; // null = not recognized
}
```

`FailureClassification` is the existing type (`provider` or `quota` with `message`, `resetAt`, `window`).

### 3.3 Client contract

Client adapters keep command building, `validateOptions`, `parseResponse`, `parseProgressEvent`, `captureUsage`, `normalizeUsage`, `versionCommand`, `catalog`. They gain:

```ts
extractFailure(stdout: string, exitCode: number): RawFailure | null;
```

`null` means the turn succeeded. Only the client decides success. A non-zero exit never yields `null`.

### 3.4 Provider profiles

`defaultProviders(): Record<string, ProviderProfile>` in the kernel, next to `FailureClassification`:
- `byteplus`: text rules (3.5).
- `claude`, `codex`, `grok`, `agy`: `classify` returns `null`. They exist only so doctor can tell a known provider from an unknown one.
- `opencode` and any unknown id: no profile.

### 3.5 The `byteplus` text rule

Applied to `raw.message`:
- Match: `/exceeded[^.]*quota/i`. No match returns `null`.
- `window`: `(\d+)-hour` becomes `"<N>h"`, else `null`.
- `resetAt`: `YYYY-MM-DD HH:MM:SS ±ZZZZ` parsed as that offset and converted to UTC ISO, else `null`.
- Result: `{ kind: "quota", message, resetAt, window }`.

Fixture: the sentence in section 1 gives `resetAt = 2026-10-22T10:43:08.000Z`, `window = "5h"`.

## 4. Classification pipeline

Run after every turn, including exit 0, because some failures arrive on stdout with exit 0.

1. `exitCode === null` (executor error): `provider` failure with the executor message. Stop.
2. `raw = client.extractFailure(stdout, exitCode)`. `null` means success. Stop.
3. If `raw.rateLimit` is set: `quota` with its `resetAt` and `window`. Stop.
4. If a profile exists for the provider and `profile.classify(raw)` is non-null: return it. Stop.
5. Otherwise: generic `provider` failure with `raw.message` (or `CLI exited with code N.`).

Rules:
- A profile cannot turn a failure into a success.
- A `quota` result with `resetAt: null` keeps the existing no-wait behavior.
- If the provider has no profile, log one warning per session: text-based quota detection is off for that provider.
- Quota waits stay keyed by the event's `provider` field (now the backend). Stages sharing a provider share a wait regardless of client.

## 5. Accepted consequences

- A config with `provider: opencode` that actually talks to BytePlus loses quota detection once the old path is removed. The owner writes `provider: byteplus`, `client: opencode`. Nothing migrates it, nothing guesses it.
- `provider` changes meaning. Anything reading events from outside adjusts. No alias, no compatibility layer.
- The `byteplus` profile has one real sample, from opencode. It is verified for opencode only.

## 6. Steps

Every step leaves build and tests green. Steps 1 to 4 do not change behavior for existing configs. Step 5 is the only destructive step.

### Step 0. Baseline

- Run `npm test` and `tsc --noEmit` in every package; record the result in the PR.
- Add characterization tests for the current behavior:
  - Claude `rate_limit_event` -> `quota`.
  - The BytePlus fixture through the current opencode adapter.
  - Non-zero exit for codex, grok, agy -> `provider`.
  - `session-freeze` and `config-edit` round-trip of `(provider, model, options)`.
- Confirm the tree is clean (`89eda70` and the staged plan only).

Done when: baseline tests exist and pass against unmodified source.

### Step 1. Types, profiles, resolver (no runtime use)

- `kernel/src/adapter.ts`: add `RawFailure`, `ProviderProfile`, `defaultProviders()`, the default client table, `resolveClient`.
- Add the `byteplus` rule. Leave `quotaFromMessage` in the opencode adapter untouched.
- Tests: `byteplus` rule against the fixture, a message without a time, a message that is not a quota; `resolveClient` for every table row, an explicit `client`, and `byteplus` without `client` (error).

Done when: new code is unit-tested and not referenced by the runner.

### Step 2. `client` in config and persisted targets

- `config.ts`: optional `client` on `StageTarget`, `ModelOverride`, `stageTargetSchema`, `loadModelTarget`, the override path. Override rule: `--client` is optional with `--provider --model`; `client` alone is an error.
- Before editing, check whether any validator rejects the new key (`workflow.ts`, `migration.ts`, `config-edit.ts`, `session-freeze.ts`). Bump `SCHEMA_VERSION` (`workflow.ts:78`, currently 2) in this step only if one does.
- `session-freeze.ts` (`:54`, `:115-129`, `:237`, `:343-350`): store the resolved `client`; include it in the frozen-vs-live comparison. A frozen target without `client` goes through the resolver.
- `config-edit.ts` (`matchingModelName`, `syncScalar`, YAML render near `:572`): read, write and match `client`, so entries differing only by client are neither dropped nor merged.
- Tests: `client` absent, present, invalid; round-trip of both persisted forms with and without `client`; two entries that differ only by client stay distinct.

Done when: all pre-existing tests pass unchanged and `client` survives freeze and config edit.

### Step 3. Look adapters up by client

- First, build the full inventory: `grep -rn "\.provider\b\|provider:" packages/*/src` (about 157 hits in 24 non-test files) and read `selection.ts` and `session-fold.ts`. Record the file list in the PR description.
- Switch lookups to `resolveClient`: `agent-runner.ts`, `doctor.ts`, `metrics.ts`, `migration.ts`, `session-store.ts`, `cli/src/provider.ts`, `cli/src/commands/init.ts`, `cli/src/commands/provider.ts`, `dispatch.ts`, `session-fold.ts`, `session-repair.ts`, `cli/src/commands/agent.ts`, `cli/src/commands/config.ts`.
- Rename the Claude adapter's client id to `claude-code` in this step, together with the default table row already added in Step 1.
- Record `client` in `execution.started` and in the `provider.stage_started` details. Resume and `metrics.ts` read `client` from the record or resolve it from `provider`.
- `execute.ts` keeps keying waits by `provider`; `client` is only added to wait events.
- Unsupported client error: `Unsupported CLI client: X. Supported: ...`.
- One commit per group of files.
- Tests: resume of an execution with `client`; usage normalization; `doctor` on a config using `client`.

Done when: a stage with `provider: byteplus, client: opencode` runs end to end, and every existing config behaves as before.

### Step 4. Pipeline, adapter by adapter (additive)

- Add `extractFailure` to adapters, one commit each, in this order: opencode, claude-code, codex, grok, agy.
  - opencode: last `error` event message; `null` on exit 0 with no `error` event.
  - claude-code: `message` from assistant/result text; `rateLimit` from a `rate_limit_event` with `status: "rejected"` (`resetsAt` seconds to ISO, `rateLimitType` as `window`); `null` only when exit is 0, there is no `is_error` result and no rejected event.
  - codex, grok, agy: exit code and parsed text; `null` on exit 0.
- `agent-runner.ts`: replace `classifyFinishedProcess` with the pipeline of section 4. While an adapter still lacks `extractFailure`, call its old `classifyFailure`.
- Test matrix (fixtures, not the old session's records):
  - `claude-code + claude`, rejected `rate_limit_event` -> `quota` with `resetAt` and `window`.
  - `opencode + byteplus`, BytePlus text -> `quota`, `resetAt 2026-10-22T10:43:08.000Z`, `window 5h`.
  - `claude-code + byteplus`, the BytePlus text in `message`, no `rateLimit` -> `quota` via the profile.
  - `opencode + opencode`, the BytePlus text -> `provider`.
  - `opencode + <unknown id>` -> `provider`, one warning per session.
  - Profile returns `null` on a non-zero exit -> `provider`.
  - Exit 0 with no failure signal -> success for every client.
  - The `opencode + byteplus` result is scheduled by the existing wait path of `provider-failure-retry.md`.

Done when: all five adapters implement `extractFailure` and the matrix passes.

### Step 5. Remove the old path

- Delete `classifyFailure` from `AgentAdapter` and every adapter, and `quotaFromMessage` with its call in `opencode-adapter.ts`.
- Move `classify-failure.test.ts` and the opencode classify cases onto `extractFailure` plus the pipeline.
- Check `index.ts:13` consumers, then delete the throwing `CodexAdapter` / `GrokAdapter` stubs in `kernel/src/adapter.ts` in a separate commit, or move only the interface if something imports them.

Done when: `grep -rn "classifyFailure\|quotaFromMessage" packages/` returns nothing outside git history, and all tests pass.

### Step 6. Doctor, templates, CLI, docs

- Doctor: `models.<name>.client` must name a known adapter (error). A provider without a profile is a warning that text quota detection is off. A provider with no default client and no `client` is an error.
- Update `.agents/skills/migent/.migent-template.json` and `packages/cli/src/templates/migent/` to the new shape; regenerate `content_sha256` as `packages/cli/src/commands/skill.ts:113-121` does.
- CLI: `--client` next to `--provider` on `agent` and `execute` (`cli/src/program.ts`). `migent provider` lists clients and providers as two separate lists. Log lines show the pair, for example `byteplus via opencode/coding-plan/dola-seed-2.0-code` (`roleStartLine` in `display.ts`, `provider.stage_started` summary).
- Docs: `docs/cli.md`, `docs/providers.md`, `docs/workflows.md`, `README.md`, both skill copies, both `references/config.md` copies, `CHANGELOG.md`.
  - Changelog: `provider` now names the backend; `client` is new; `provider: opencode` configs that talk to BytePlus lose quota detection until changed to `provider: byteplus, client: opencode`.
  - `docs/providers.md` and both `references/config.md`: `opencode` is both a client and a provider; `provider: opencode` has no profile, so text quota failures are plain `provider` failures and no wait is scheduled; to get quota detection write `provider: byteplus` and `client: opencode`; one config example for each; migent does not infer the provider or rewrite old entries; a table of what each client puts in `RawFailure` (`message` always, `rateLimit` only for `claude-code`).
- Tests: doctor warning on `opencode`; no warning for `claude`, `codex`, `grok`, `agy`, `byteplus`; error on `byteplus` without `client`; shipped templates parse; option parsing; `migent provider` output; display line.

Done when: `migent doctor` is clean on the shipped templates and the docs describe the new shape.

### Step 7. Internal renames (optional, separate commit)

`ProviderAdapter` / `AgentAdapter` to `ClientAdapter`, `provider-events.ts` to `client-events.ts`. Stored event names and fields do not change.

## 7. Verification

- `npm test` and `tsc --noEmit` per package after each step.
- The fixture from section 3.5 classifies as `quota` with `resetAt 2026-10-22T10:43:08.000Z` through `opencode + byteplus` and is scheduled by the existing wait path.
- An old config (`provider: opencode`, no `client`) still runs after steps 1 to 4 and, after step 5, runs with generic classification.

## 8. Out of scope

- Configuring a client to reach another backend (base URL, auth, environment).
- Inferring the provider from a model name.
- Cost and capability tables per model, and normalizing `cost_usd` for plans that report `0`.
- Changing `provider.*` event names.
- Migrating old events, execution records or `provider: opencode` entries.
- Retry timing and wait behavior, which stay as in `provider-failure-retry.md`.
