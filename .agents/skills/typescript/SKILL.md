---
name: typescript
description: Write and review TypeScript using principles beyond lint and typechecking.
---

# TypeScript

## Steps

1. Identify the created, changed, or reviewed `.ts` and `.tsx` files in scope.
   Read narrower project rules; they take precedence.
2. Apply the engineering and TypeScript rules below to those files. Preserve stable
   rule IDs and default severities; explain any severity adjustment.
3. For implementation, correct applicable violations within the authorized scope.
   For review, report findings without editing code.
4. After edits, run the project's lint and build separately. These rules cover
   what lint and the compiler cannot check; do not duplicate their diagnostics.
5. Report each finding with rule ID, level, file and line, and a one-line fix.
   Group by severity, blockers first. If there are no findings, say so.

## Rule IDs

Each rule has a stable kebab-case ID that names the rule (for example `fail-fast`).
New rules get a new unique ID; existing IDs never change or get reused.
Group a rule by its section, not by its ID.
A narrower project rule takes precedence over this skill.

## Severity

| Level | Meaning |
| :--- | :--- |
| **blocker** | Must be fixed before the change is accepted |
| **major** | Should be fixed in the same change unless the author justifies it |
| **minor** | Fix when touching the code; do not block on it |

Each rule states its default level. Report a different level only with a reason.

## Engineering principles

| ID | Level | Principle | Requirement | Exceptions |
| :--- | :--- | :--- | :--- | :--- |
| `descriptive-names` | major | Descriptive names | Names state intent. No single-letter names except loop indexes and short callback parameters | — |
| `rule-of-three` | major | Rule of three | Extract shared logic when the third copy appears within the same module or package | Shapes that match by coincidence; test fixtures; generated code |
| `guard-clauses` | major | Guard clauses | Keep the main path flat: reject invalid input at the top with an early `return` or `throw`. | Do not split a single domain condition into several guards only to reduce nesting |
| `fail-fast` | blocker | Fail fast | When an invariant is violated, throw instead of returning `null`, `undefined`, or a default. When code requires a value, obtain it through a function that throws if it is missing (for example `requireUser`), so interior code receives a non-null value | Absence that is a valid domain state stays representable |
| `nullable-at-edge` | major | Nullable at the edge | Resolve absence before passing values to functions that require them; avoid repeated null checks | Lookups, parsers, transformations, and domain operations may return nullable values when absence is a valid result |
| `catch-at-boundary` | blocker | Catch at the boundary | Let errors propagate unless handling them at an output boundary or performing explicit recovery. Preserve the cause; do not hide failures behind empty results or wrap every `await` | Interior catches may implement bounded retries, domain error translation, or cleanup followed by rethrow |
| `no-invalid-states` | major | Make invalid states unrepresentable | Model each state as one variant of a discriminated union instead of optional fields that allow impossible combinations | Persisted or wire formats may keep their external shape; narrow them at the boundary |
| `domain-not-delivery` | major | Separate domain from delivery | Keep domain logic out of UI, CLI, HTTP, and framework adapter modules; adapters call the domain | — |

## TypeScript rules

### Naming

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `file-named-by-export` | minor | Name a file after its primary export; no vague suffixes such as `utils2` or `helpers-new` |
| `noun-types` | minor | Class and type names are nouns |
| `verb-functions` | minor | Function names are verbs or verb phrases (`fetchNodes`, `isReady`, `toDto`). Do not force a `get` / `is` / `set` prefix. Event handlers may use `on*` / `handle*` |
| `no-abbreviations` | minor | Avoid abbreviations unless they are standard in the domain (`id`, `url`, `http`) |

### Types

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `type-for-aliases` | minor | Use `type` for unions, tuples, mapped types, and aliases |
| `interface-for-extension` | minor | Use `interface` only for declaration merging or an object type meant to be extended. Do not convert between `type` and `interface` for equivalent shapes; match the file |
| `readonly-shared` | major | Mark exported or shared data `readonly` (`Readonly<T>`, `readonly T[]`). Local values that never escape need not be |
| `satisfies-over-as` | major | Prefer `satisfies T` over `as T` when checking a value against a type |
| `narrow-with-predicates` | major | Narrow with type predicates and discriminated unions. Use `in` only for object-key checks. Do not rely on `instanceof` for values that may cross package or realm boundaries |
| `exhaustive-never` | major | Use `never` to make `switch` and union handling exhaustive |

### Functions and classes

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `no-monkey-patch` | blocker | Do not modify built-in prototypes, globals, or objects exported by other packages |
| `no-void-annotation` | minor | Do not annotate obvious `void` returns |
| `composition` | major | Prefer composition over inheritance |
| `minimal-public-api` | major | Keep members `private` or module-private unless they are part of the intended API. Do not add getters and setters that only forward to a field |
| `explicit-fields` | minor | Declare class fields explicitly. Constructor parameter properties are fine for injected dependencies |

### Collections and enums

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `unions-over-enums` | major | Use string-literal unions (or an `as const` object) for closed sets. Do not add numeric enums, and do not add an `enum` when a union is enough |
| `record-vs-map` | minor | Use `Record<K, T>` for maps with string keys; use `Map` when keys are not strings or insertion order matters |

### Async

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `parallel-await` | major | Run independent work in parallel with `Promise.all` or `Promise.allSettled` instead of sequential `await` |
| `abort-signal` | major | Cancel work with `AbortSignal` / `AbortController`. Do not use `Promise.race` as the default timeout mechanism |

### Errors

Catch placement and fail-fast behavior follow `fail-fast` and `catch-at-boundary`.

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `domain-errors` | minor | Define error classes per domain area when callers need to distinguish failures |
| `error-context` | major | Error messages say what failed and include the identifying value (id, path, name). Preserve the original error with `cause` |
| `sanitize-errors` | blocker | Errors shown to end users or external clients contain no secrets or raw internals |
| `release-resources` | major | Release held resources with `try/finally` or `using`. Do not add an empty `finally` |

### Comments

| ID | Level | Requirement |
| :--- | :--- | :--- |
| `why-comments` | minor | Comments explain why, not what |
| `jsdoc-when-needed` | minor | Add JSDoc to new public API only when types cannot express it (thrown errors, units, invariants) |
| `no-dead-code` | minor | Do not leave commented-out code |
