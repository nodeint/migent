# @nodeint/migent-workflow

Workflow definition for Migent: the document model, the strict parser, the
draft collector that reports every problem at once, the cross-workflow catalog
checks, and loading of `.migent/workflows`. It does not run workflows; the
engine and sessions live in `@nodeint/migent-kernel`.

It also exports `ConfigurationError`, `isRecord`, `documentVersion`, `pyRepr`,
and `parseYamlDocument`. These are shared utilities for Migent packages, not
workflow API.

Behavior is documented in the repository's `docs/workflows.md`.
