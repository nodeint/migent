# @nodeint/migent-adapters

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Client adapters for Migent: Antigravity, Claude, Codex, Grok, and OpenCode. Internal; no stable public API.
Contracts: [docs/adpaters.md](../../docs/adpaters.md).

## Rules

- Implement the shared `CliClient` contract from `@nodeint/migent-contracts` (the kernel re-exports it),
  extended with `optionsCommand` and `parseOptions`.
- Import only `@nodeint/migent-contracts` from Migent packages.
- Register new clients in `src/clients/registry.ts`.
- A discovered headless option is not a supported option until validation accepts it.
- Tests never run a real client CLI; inject `which` and `runCommand`, or use `integration/fixtures/bin`.

## Key symbols

| Symbol | File | Purpose |
| --- | --- | --- |
| `createClient`, `clientIds` | `src/clients/registry.ts` | Client registry |
| `ClaudeCodeClient`, `CodexClient`, `GrokClient`, `OpencodeClient`, `AgyClient` | `src/clients/` | Clients |
| `ModelCatalog` | `src/catalog.ts` | Model discovery |
| `parseHelpOptions` | `src/utils/parse-help-options.ts` | Headless option discovery |
| `CliClient`, `HeadlessOption` | `src/types.ts` | Adapter-only types and the extended client; `CommandSpec`, `TurnUsage`, `UsageCapture` re-export from contracts |
