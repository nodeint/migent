import Type from 'typebox';

import { nullable } from './common.js';

const Status = Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('interrupted')], {
  description: '`interrupted`: the invocation started and recorded no result. An external effect of the plugin is in an unknown state.',
});
const ActivePlugin = Type.Object({
  id: Type.String(), version: nullable(Type.String()), enabled: Type.Boolean(), advisory: Type.Boolean(),
});
const IntentResult = Type.Object({
  kind: Type.String(), status: Type.String(), reason: nullable(Type.String()), path: nullable(Type.String()),
});
const Failure = Type.Object({ reason: Type.String(), error: nullable(Type.String()), on_error: Type.String() });
const Invocation = Type.Object({
  invocation_id: nullable(Type.String()),
  plugin: Type.String(),
  hook: nullable(Type.String()),
  status: Status,
  results: Type.Array(IntentResult),
  failure: nullable(Failure),
  agent_calls: Type.Number(),
});
const Hold = Type.Object({
  plugin: Type.String(),
  hook: nullable(Type.String()),
  on_error: Type.Union([Type.Literal('stop'), Type.Literal('fail')]),
  error: nullable(Type.String()),
});

/** The `plugins` field of `session show --json`. */
export const PluginsSection = Type.Object({
  active: Type.Array(ActivePlugin),
  invocations: Type.Array(Invocation),
  added_after_freeze: nullable(Type.Array(Type.String())),
  live_unavailable: nullable(Type.String()),
  holds: Type.Array(Hold),
  freeze_mismatch: nullable(Type.String()),
}, { description: 'Derived on read from `plugins.frozen` and `plugin.*`. Absent when the session recorded no plugin data.' });
