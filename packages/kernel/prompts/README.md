# Kernel prompt templates

These Markdown/Handlebars assets own the wording and layout sent to providers.
`prompt.ts` selects execution context and resolves paths; `runtime.ts` renders
the provider envelope. Workflow and role instructions remain workspace data.

- `stage-start`, `stage-continue`, `stage-reply`, and `verify-repair` describe
  the messages for each workflow turn.
- `role-run` formats role instructions for standalone calls.
- `provider-turn` places the message, response contract, artifact directory,
  and previous verification report in their final order.
- `task`, `continuation`, `response-contract`, and `artifact` are shared partials.
- `history` formats replay for providers without native conversation resume.

Rendering uses strict variable lookup, no HTML escaping, and no automatic
standalone-line removal. Context text is inserted literally, never rendered
again as a template. Preserve whitespace when changing protocol templates.
The contract fixtures were captured from the renderer before this refactor.

Builds copy these assets beside the kernel modules in `dist/prompts`; compiled
modules never fall back to source assets. Add new template names to the renderer.
