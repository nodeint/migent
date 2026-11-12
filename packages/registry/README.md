# @nodeint/migent-registry

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Machine-local workspace registry service for Migent. Internal; no stable public API.

## Rules

- Liveness is proven by connecting to the service endpoint, never by pid. Keep socket paths under
  100 bytes; `serviceEndpointPath` falls back to a short temp path.
- The child re-executes its own module and watches IPC `disconnect` before it is published; do not bundle.
- Process code uses Node built-ins and `proper-lockfile` only.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `startDetached`, `serveForeground`, `stop`, `serviceStatus` | `src/service.ts` | Service lifecycle |
| `callService`, `ServiceError` | `src/service.ts` | Client calls |
| `serviceEndpointPath`, `queryEndpoint` | `src/endpoint.ts` | Endpoint and liveness |
| `registryHomePath`, `migentHomePath` | `src/home.ts` | Registry home |
| routes, store | `src/routes.ts`, `src/store.ts` | Request handling, persistence |
