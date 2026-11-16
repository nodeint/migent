---
name: eslint
description: Write and validate TypeScript against repository ESLint rules.
---

# ESLint

## Steps

1. Read contribution rules, package scripts, ESLint config, and the lint wrapper.
   Determine the package manager, working directory, target syntax, and strict command.
   Do not assume wrappers forward arguments unchanged; ask if required commands
   or prerequisites cannot be established.
2. Select the requested TypeScript files or their owning directories. For implementation
   work, lint after editing.
3. Run the strict command on that scope, treating warnings as failures. Record the
   command, paths, and result. Follow repository stop rules when it fails.
4. When edits are authorized and continuation is permitted, fix violations or run
   supported automatic fixes. Inspect the diff; do not weaken config or suppress
   findings merely to pass.
5. Rerun strict verification on the same scope after fixes.
6. Report commands, target paths, results, and anything unverified. Claim strict
   verification passed only when it ran successfully for the requested scope.
