import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";

/**
 * The schema_version 4 to 5 rewrite of a config mapping, in place:
 * `models` becomes `agents`; an agent's `client: <id>` becomes `client.type` and its `options`
 * become `client.options`; a role's `default_model` becomes `agent` and its `instructions` become
 * `responsibilities`. Returns one note per change. Applies to config.yaml and config.local.yaml alike.
 */
export function liftConfigAgents(config: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (Object.hasOwn(config, "models")) {
    if (Object.hasOwn(config, "agents")) {
      throw new ConfigurationError("config has both models and agents; merge them into agents before migrating.");
    }
    const models = config.models;
    if (isRecord(models)) {
      const agents: Record<string, unknown> = {};
      for (const [name, body] of Object.entries(models)) {
        agents[name] = isRecord(body) ? liftAgentBody(body, `agents.${name}`, notes) : body;
      }
      renameKey(config, "models", "agents", agents);
    } else {
      renameKey(config, "models", "agents", models);
    }
    notes.unshift("models -> agents");
  }
  if (isRecord(config.roles)) {
    for (const [name, role] of Object.entries(config.roles)) {
      if (!isRecord(role)) continue;
      const label = `roles.${name}`;
      const lifted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(role)) {
        if (key === "default_model") {
          if (Object.hasOwn(role, "agent")) throw new ConfigurationError(`${label} has both default_model and agent.`);
          lifted.agent = isRecord(value) ? liftAgentBody(value, `${label}.agent`, notes) : value;
          notes.push(`${label}.default_model -> agent`);
        } else if (key === "instructions") {
          if (Object.hasOwn(role, "responsibilities")) {
            throw new ConfigurationError(`${label} has both instructions and responsibilities.`);
          }
          lifted.responsibilities = value;
          notes.push(`${label}.instructions -> responsibilities`);
        } else {
          lifted[key] = value;
        }
      }
      config.roles[name] = lifted;
    }
  }
  return notes;
}

function liftAgentBody(body: Record<string, unknown>, label: string, notes: string[]): Record<string, unknown> {
  const hasClientString = typeof body.client === "string";
  const hasOptions = Object.hasOwn(body, "options");
  if (!hasClientString && !hasOptions) return body;
  const lifted: Record<string, unknown> = {};
  const client: Record<string, unknown> = isRecord(body.client) ? { ...body.client } : {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "client" && hasClientString) {
      client.type = value;
      notes.push(`${label}.client -> client.type`);
    } else if (key === "options") {
      if (value != null) client.options = value;
      notes.push(`${label}.options -> client.options`);
    } else {
      lifted[key] = value;
    }
  }
  if (Object.keys(client).length > 0) {
    // `type` reads first, as in the documented layout.
    const { type, options, ...rest } = client;
    lifted.client = {
      ...(type === undefined ? {} : { type }),
      ...rest,
      ...(options === undefined ? {} : { options }),
    };
  }
  return lifted;
}

/** Renames a key without moving it: the other keys keep their order. */
function renameKey(target: Record<string, unknown>, from: string, to: string, value: unknown): void {
  const entries = Object.entries(target);
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, item] of entries) {
    if (key === from) target[to] = value;
    else target[key] = item;
  }
}
