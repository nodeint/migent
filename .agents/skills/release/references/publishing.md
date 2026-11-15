# Publishing prerequisites and recovery

Read the repository release docs before these steps.

## Prerequisites

1. Confirm required branch checks, merge method, tag ownership, and release permissions.
2. Identify registry, package names, publishing automation, trusted publisher or
   credential setup, and any first-publication requirements.
3. Verify publisher identity matches repository, workflow, and environment.
4. Confirm build output, dependency order, and version availability.
5. Stop and report missing prerequisites. Change protections or publisher settings
   only with explicit authorization.

## Recovery

1. Inspect the failed run, existing tags, release records, and published package versions.
2. Select the documented recovery path. Confirm repeatable steps and required
   authorization; ask before an undocumented recovery or new external mutation.
3. Retry only the authorized steps. Preserve published tags and versions; follow
   registry version-reuse rules and repository corrective-release or deprecation policy.
4. Verify registry propagation and installable artifacts before reporting success.
