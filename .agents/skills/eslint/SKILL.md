---
name: eslint
description: Write and validate TypeScript against repository ESLint rules.
---

# ESLint

Run commands from the repository root.

## Commands

Apply ESLint's supported automatic fixes when the task authorizes file changes:

```bash
pnpm lint:fix -- <paths>
```

Verify selected files or directories with warnings treated as failures:

```bash
pnpm lint -- <paths>
```

Arguments after `--` go to ESLint:

- Paths are files or directories; ignored paths are skipped without a warning.
- Flags pass through unchanged. Give a flag's value with `=`, for example `pnpm lint -- --format=json <paths>`;
  a separate value is read as a path.

Omit `<paths>` to run any command against the repository.
For a scoped task, pass the changed `.ts` and `.tsx` files or their owning directories.

## Handoff

When a command fails, use its reported rule IDs and file locations to correct the source, then rerun the same command.

