# @nodeint/migent-plugins

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

First-party Migent plugins and their static registry. Internal; no stable public API.

## Rules

- Leaf package: import only `@nodeint/migent-contracts`. Only `cli` depends on this package.
- Plugins propose and the core decides: a handler returns proposals and never receives the session lock, store
  handles or execution state. See [docs/architecture.md](../../docs/architecture.md).
- A plugin is `{ manifest, activate }`. `activate` registers handlers and interceptors through the activation
  context; each handler gets its own per-invocation `call` context. Keep per-invocation state out of module
  scope: two stages can run one handler concurrently. The core writes an artifact and then records it, so a
  handler must not assume a written file has a `plugin.decision`; `session show` reports the ones that lack it.
- `call.session.snapshot()` and `resumeFacts()` need `uses.session`. Never cache their result across invocations: a
  changed read makes the core discard the result and re-run the handler once, then record `stale`.
- To claim keys on workflows, stages, agents, or roles, add one entry to `PLUGIN_EXTENSIONS` in
  `@nodeint/migent-contracts` and repeat it as the manifest's `extensions`. `createPluginRegistry` rejects a manifest
  that differs from its catalog entry or omits it. Raise the entry's `version` only for an incompatible schema change.
  Read the frozen values with `config.extensions.workflow()`, `.stage(id)`, `.agent(stageId)`, and
  `.role(name)`: each returns only the calling plugin's keys, or `null`. The snapshot and `config.core` never include them.
- Register a plugin in `src/registry.ts`. The first-party plugins are `metrics` (replaces the former core seal) and
  `prompt_cache_ttl` (the prompt-cache resume policy), both `defaultEnabled`.
- A plugin may declare a pure `validate(input)` (plugin API 1.1). `migent doctor`, session creation, and role creation
  call it for every enabled plugin and refuse the problems it returns.
- A plugin may declare a pure `responseContract(input)` (plugin API 1.2) that returns `{ required, instructions }` or
  `null` for each stage when the session freezes. It needs a catalog entry with a `response` field whose only key is
  the plugin id; `createPluginRegistry` rejects a mismatch, or the member on an API below 1.2. A throw or an invalid
  result stops session creation with `plugin-response-contract-invalid`. It is not evaluated on resume.

## Key symbols

| Symbol | File | Purpose |
| --- | --- | --- |
| `createPluginRegistry`, `PluginRegistry` | `src/registry.ts` | Static registry of plugins by manifest id |
| `metricsPlugin`, `metricsManifest`, `buildMetrics` | `src/metrics/` | Session metrics plugin, its manifest and the pure document builder |
| `METRICS_PLUGIN_ID`, `METRICS_ARTIFACT_NAME` | `src/metrics/index.ts` | Names the CLI reader builds the artifact path from |
| `promptCacheTtlPlugin` (via the registry) | `src/prompt-cache-ttl/` | Prompt-cache expiry policy: `policy.ts` (pure selection and expiry), `validate.ts`, and the `conversation.resume` interceptor |
