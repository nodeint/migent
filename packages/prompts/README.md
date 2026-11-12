# @nodeint/migent-prompts

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Prompt templates and renderers for Migent. Internal; no stable public API.

## Rules

- Depend on no other Migent package. The kernel selects execution context and passes plain data in.
- Changing the response contract the agent must follow requires bumping `CURRENT_RESPONSE_PROTOCOL`.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `renderStageStart`, `renderStageContinue` | `src/index.ts` | Stage turn prompts |
| `buildStageReplyPrompt`, `formatQuestionAnswers` | `src/index.ts` | Human reply and answers |
| `renderProviderPrompt`, `addStageOutcomeContract` | `src/index.ts` | Outcome contract wrapping |
| `render*Correction`, `renderVerifyRepair` | `src/index.ts` | Correction and repair turns |
| `CURRENT_RESPONSE_PROTOCOL` | `src/index.ts` | Response protocol version |
| `renderPrompt` | `src/renderer.ts` | Template renderer |
