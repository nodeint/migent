# Prompt templates

These Markdown/Handlebars assets own the wording and layout sent to providers.
The kernel (`prompt.ts`) selects execution context and resolves paths; this package renders
the messages and provider envelope. Workflow and role instructions remain workspace data.

- `stage-start`, `stage-continue`, `stage-reply`, and `verify-repair` describe
  the messages for each workflow turn.
- `role-run` formats role instructions for standalone calls.
- `provider-turn` lays a turn out stable first: the full response contract
  (`full` mode only), the message, the `Execution` block with per-execution
  paths, then the closing `Do`. `reminder` mode skips the contract for a turn
  sent back to the same agent.
- `continuation`, `response-contract`, `execution`, and `do` are shared partials.
- Messages use `##` sections so they nest under `# Migent workflow stage`.
- `history` formats replay for providers without native conversation resume.

Rendering uses strict variable lookup, no HTML escaping, and no automatic
standalone-line removal. Context text is inserted literally, never rendered
again as a template. Preserve whitespace when changing protocol templates.
Contract renderings are locked by snapshots in `test/__snapshots__`.

Builds copy these assets beside the package modules in `dist/prompts`; compiled
modules never fall back to source assets. Add new template names to the renderer.
