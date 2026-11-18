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
- Register a plugin in `src/registry.ts`. The registry is empty until a feature plugin lands.

## Key symbols

| Symbol | File | Purpose |
| --- | --- | --- |
| `createPluginRegistry`, `PluginRegistry` | `src/registry.ts` | Static registry of plugins by manifest id |
