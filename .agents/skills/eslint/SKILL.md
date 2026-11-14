---
name: eslint
description: >
  Check and write repository TypeScript to the ESLint config. Use when
  creating or changing `.ts` or `.tsx` files, or when validating ESLint.
user-invocable: true
---

# ESLint

Run commands from the repository root.

## Commands

Inspect selected files or directories without changing them:

```bash
pnpm lint -- <paths>
```

Apply ESLint's supported automatic fixes when the task authorizes file changes:

```bash
pnpm lint:fix -- <paths>
```

Verify selected files or directories with warnings treated as failures:

```bash
pnpm lint:strict -- <paths>
```

Omit `<paths>` to run any command against the repository.
For a scoped task, pass the changed `.ts` and `.tsx` files or their owning directories.

After an automatic fix, inspect the resulting diff and run `pnpm lint:strict -- <paths>` on the same scope.
When a command fails, use its reported rule IDs and file locations to correct the source, then rerun the same command.

Read [`scripts/wrappers/run-eslint.mjs`](../../../scripts/wrappers/run-eslint.mjs) for argument and target handling.

## Handoff

Report each command, its target paths, and its result.
Do not report ESLint verification as passing when `lint:strict` failed or was not run for the requested scope.
