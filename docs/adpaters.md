# Adapters

Adapters connect Migent to headless coding-agent CLIs. The implementation lives
in `packages/adapters`; it is an internal library with no stable public API.
This document describes the shared architecture and contracts. Model configuration
belongs in [Providers and model configuration](providers.md), workflow behavior
in [Workflows](workflows.md), and process troubleshooting in
[Diagnostics](diagnostics.md).

## Responsibilities and boundaries

The adapter layer has two parts:

- A **CLI client** knows the executable, command syntax, discovery commands,
  output protocol, session identifiers, and usage fields printed by that CLI.
- A **provider** applies Migent policy over a selected client: defaults, option
  persistence, failure classification, and cumulative usage normalization.

`ProviderBase` delegates protocol work to its bound `CliClient`. Provider
subclasses add policy. Parsing native CLI output belongs in the client;
shared text parsing helpers belong in `src/utils`.

The CLI owns authentication, tool execution, and its conversation history.
Migent owns model selection, prompt construction, workflow routing, process
execution, and persistence. Adapters describe commands; they do not schedule
workflow stages or execute subprocesses themselves.

## Layout and contracts

| Location | Responsibility |
| --- | --- |
| `src/types.ts` | Adapter contracts and normalized data types |
| `src/clients/` | Client command builders and protocol parsers |
| `src/providers/` | Provider policy, client binding, and provider registration |
| `src/utils/` | Reusable parsing helpers without client selection logic |
| `src/options/` | Captured headless help samples |
| `src/catalog.ts` | Model catalog and model-specific option values |
| `src/index.ts` | Exports and default provider registration |
| `test/` | Contract tests and protocol fixtures |

The kernel also defines the runner-facing provider contracts. Changes to shared
contract shapes must remain structurally compatible across these packages.
The doctor loads model catalogs; the CLI currently orchestrates headless option
discovery. Neither operation belongs inside a pure text parser.

## Client selection

`createClient(id)` resolves a registered client and rejects an unknown ID.
`clientIds()` returns the registered IDs. A provider can have a default client
or require an explicit model-level `client` selection.

`withClient(id)` binds the same provider policy to another client. `command`
and `effortOption` follow that selected client. A provider without a default
client reports `requiresClient`; operations needing a client fail until one is
selected. `provider list` excludes providers that require explicit selection.

## Building and reading a turn

`runCommand(input)` returns a `CommandSpec` with `argv` and optional `stdin`.
Its input includes the model, workspace, prompt, prior or new agent ID, prompt
file, last-message file, and resolved string-valued options. The client chooses
how to encode these inputs for its CLI. The runner launches the process.

`ProviderBase.buildCommand()` creates a fresh event parser, validates options,
and delegates to the client. A provider can apply its defaults before delegation.
Keep argument boundaries in the argv array; do not construct a shell command.

`parseRun(stdout, lastMessageFile)` returns final text and a session ID.
`parseResponse()` exposes that result to the runner as a tuple. Clients may read
the last-message file when their protocol uses it. Progress is separate:
`createEventParser()` returns a per-run function that consumes output lines and
returns a normalized event or null. Stateful parsers must not leak state across runs.

## Sessions and interruption

Clients may implement `newSessionId()` when the CLI accepts a caller-generated
identity. Otherwise the CLI supplies the session identity. `sessionIdFromLine()`
can reveal it before the process finishes. A resumed turn passes the existing
agent ID back through the command builder.

Some CLIs keep server-side work alive after their local process ends. Optional
`interruptCommand()` and `classifyInterrupt()` describe how to stop and interpret
that work. Outcomes are `interrupted`, `idle`, `not-found`, or `failed`.
Stopping the local process tree remains a runner responsibility. Workflow resume
and artifact dependencies are described in [Sessions](sessions.md).

## Model and version discovery

`modelsCommand()` and `parseModels()` produce a `CliModelCatalog` containing
model IDs, an optional default ID, and model-specific option values.
`ModelCatalog.valuesFor(model, option)` returns known values or null when unknown.
An empty known list is distinct from null: it means the model accepts no values
for that option.

`optionValuesCommand(option, model)` supplies an additional discovery command
when necessary, or null when none exists. `parseOptionValues()` interprets its
output. The doctor checks catalog values first and only probes separately when
needed. A known-value list can support selection and validation; unknown values
must not be treated as an empty list.

`versionCommand()` and `parseVersion()` expose CLI version information for
execution records and diagnostics.

## Headless option discovery

Each client owns `optionsCommand()` and `parseOptions(help)`. The command asks
for help in the execution mode used for headless turns. The parser returns
`HeadlessOption[]`; it does not select a client or launch a process.

Clients may call `utils/parse-help-options.ts` with their help-table format.
A client whose format cannot be represented by that helper should implement
its own parser. The helper strips terminal colors, reads the selected options
section, joins wrapped descriptions, and extracts documented metadata.

| Field | Meaning |
| --- | --- |
| `name` | First long flag without leading dashes, or the short flag when no long flag exists |
| `flags` | Flag spellings listed in the option header |
| `description` | Joined description, including help metadata |
| `argument` | Argument placeholder as printed, or null |
| `valueMode` | `required`, `optional`, `none`, or `unknown` |
| `type` | `string`, `number`, `boolean`, `array`, or `unknown` |
| `choices` | Enumerated values extracted from supported help annotations, or null |
| `defaultValue` | Default text extracted from help, or null |

The result is JSON serializable. Unknown information stays unknown. The parser
does not infer numeric constraints from prose or guarantee that every choice,
alias, dependency, or default mentioned in prose has been extracted. A CLI can
also display interactive flags in headless help. Discovery alone does not make
a flag suitable for Migent configuration.

The options runner combines stdout and stderr on successful exit, since help
may use either stream. It applies a 15-second timeout and reports launch or
nonzero-exit failures. Parsing fails when no option table can be read. Catalogs
are fetched on each listing; there is no persistent cache or version-keyed cache.

## Listing and JSON output

```bash
migent provider list --json
```

For each provider, the command reports `name`, `command`, `path`, `available`,
`models`, `default_model`, `options`, `headless_options`, and `problems`.
It does not require project configuration.

`options` remains Migent's configured option metadata: `name`, `prompt`,
`allow_default`, and `overridable`. `headless_options` is the newly discovered
native help catalog. It is null when the CLI is absent or discovery fails.
Help discovery and model discovery run independently: one can succeed when the
other fails. Help errors are prefixed with `Headless options:` in `problems`.
The human-readable listing currently displays the existing option metadata.

The top-level `ok` is true only when all listed providers have no problems.
The command exits 0 when any provider returns models and 1 otherwise; exit 0
therefore does not imply `ok: true`. Per-model option values are not fetched
for every model during listing.

## Configuration and validation

Model options form the base settings. Stage options override matching keys;
command-line overrides apply last. The model-level `effort` alias resolves to
the selected client's `effortOption`. An alias and its native option cannot both
be set on a model. See [model configuration](providers.md#model-effort).

The existing `options()` metadata controls prompting, default selection, and
which settings `profileOptions()` retains on a provider session. These are
Migent policies, not facts that a CLI help parser can determine.

`validateOptions()` currently remains client-owned. Configuration resolution and
the runner call it; interactive configuration also checks discovered per-model
values where available. The new headless catalog does **not yet replace** these
validators, populate configuration prompts, or drive argv generation.

Before using it for validation, the integration must account for options Migent
controls, such as prompts, output protocol, model selection, and session IDs.
Native flag names may differ from stored configuration names. CLI config-key
overrides may also expose a different surface from execution flags. The client
must retain responsibility for that mapping and encoding.

## Failures and usage

`extractFailure(stdout, exitCode)` returns native failure facts or null for a
successful run. A nonzero exit must produce a failure. A protocol can identify
rate limits with an optional reset time and window. `ProviderBase.classifyFailure()`
turns those facts into `quota` or `provider` failures; it does not infer a reset
time absent from the CLI protocol. Runner process-start diagnostics are separate
from failures reported by a running CLI; see [Diagnostics](diagnostics.md).

`captureUsage()` selects the CLI's usage payload and stores it as a raw capture.
`readUsage()` translates it into nullable token and cost fields and identifies
which fields are cumulative across the conversation. `normalizeUsage()` subtracts
the previous capture for cumulative fields. Missing values and negative deltas
become null; per-turn fields pass through. Missing usage must not become zero.

Normalized fields are `input_tokens`, `output_tokens`, `reasoning_tokens`,
`cache_read_tokens`, `cache_write_tokens`, and `cost_usd`. Input excludes cache
reads; reasoning is reported alongside output and is not added to it. Costs come
from reported usage, without a Migent price table.

When a workflow completes, metrics normalize stored captures and write
`metrics.json`. Later adapter changes do not rewrite that file. Aggregation,
partial totals, and uncaptured turns are described in [Session metrics](session-metrics.md).

## Extending and verifying adapters

Implement the CLI contract in a client, reuse parsing helpers where appropriate,
and register the client factory. Add provider policy only when defaults or
accounting require it. Register a provider separately when it should appear in
the default provider map.

Use captured help and protocol fixtures to test parsing without authentication
or model execution. Cover wrapped text, aliases, optional arguments, metadata,
unknown fields, and malformed output. Test discovery failures independently of
model failures. For execution protocols, cover initial and resumed sessions,
progress, failed runs, usage capture, and cumulative deltas. Run relevant tests
and the workspace build after changing shared contracts.
