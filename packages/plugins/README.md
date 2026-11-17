# @nodeint/migent-plugins

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

First-party Migent plugins and their static registry. Internal; no stable public API.

## Rules

- Leaf package: import only `@nodeint/migent-contracts`. Only `cli` depends on this package.
- Plugins propose and the core decides: a handler returns intents and never receives the session lock, store
  handles or execution state. See [docs/architecture.md](../../docs/architecture.md).
- Register a plugin in `src/registry.ts`. The registry is empty until a feature plugin lands.

## Key symbols

| Symbol | File | Purpose |
| --- | --- | --- |
| `createPluginRegistry`, `PluginRegistry` | `src/registry.ts` | Static registry of plugins by manifest id |
