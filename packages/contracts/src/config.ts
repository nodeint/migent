import Type, { type Static } from "typebox";
import { id, nullable } from "./common.js";

/**
 * Structure of `.migent/config.yaml` / `config.local.yaml` and of the merged (effective) config.
 * Pure data: error codes, messages, normalization, and semantic rules (client registry, effort
 * support, model availability) live in the kernel. Objects are open unless a comment says otherwise.
 */

/** A mapping with any keys and values. */
export const ConfigMapping = Type.Record(Type.String(), Type.Unknown(), { description: "A mapping." });

/** A string with at least one non-whitespace character. */
export const NonBlankString = Type.String({ pattern: "\\S", description: "A string with a non-blank value." });

/** Native option names accepted by Migent, before a client validates them. */
export const OPTION_KEY_PATTERN = "^[A-Za-z][A-Za-z0-9_.-]*$";

export const ClientOptions = Type.Record(Type.String(), NonBlankString, {
  propertyNames: { pattern: OPTION_KEY_PATTERN },
  $id: id("config/client-options"),
  title: "Client options",
  description: "Native options for the selected client. Keys are option names; values are non-blank strings.",
});

/** Closed: an unknown key is an error. */
export const ClientSelection = Type.Object(
  {
    type: Type.Optional(nullable(NonBlankString)),
    options: Type.Optional(nullable(ClientOptions)),
  },
  {
    $id: id("config/client"),
    title: "Client selection",
    description: "The CLI client that runs the model. `type` is required when `options` is set.",
    additionalProperties: false,
  },
);

const agentFields = {
  model: NonBlankString,
  effort: NonBlankString,
  client: nullable(ClientSelection),
};

/** Field definitions shared by every agent shape, none required. */
export const AgentFields = Type.Object(
  {
    model: Type.Optional(agentFields.model),
    effort: Type.Optional(agentFields.effort),
    client: Type.Optional(agentFields.client),
  },
  { $id: id("config/agent-fields"), title: "Agent fields" },
);

/** `agents.<name>` in one layer. Either layer may supply part of an entry, `{}` included. */
export const NamedAgentFragment = Type.Object(
  { ...AgentFields.properties },
  { $id: id("config/named-agent-fragment"), title: "Named agent (layer)", description: "A partial named agent in one config file." },
);

/** An inline agent replaces wholesale, so it is complete when supplied. */
export const InlineAgent = Type.Object(
  { model: agentFields.model, effort: Type.Optional(agentFields.effort), client: Type.Optional(agentFields.client) },
  { $id: id("config/inline-agent"), title: "Inline agent", description: "A complete agent definition." },
);

export const ResolvedAgent = Type.Object(
  { model: agentFields.model, effort: Type.Optional(agentFields.effort), client: Type.Optional(agentFields.client) },
  { $id: id("config/resolved-agent"), title: "Agent (effective)", description: "A named agent after layers merge." },
);

/** An unmapped named agent: waiting for a local mapping. */
export const AgentPlaceholder = Type.Object(
  {},
  {
    $id: id("config/agent-placeholder"),
    title: "Unmapped agent",
    description: "An empty entry that a local config file maps to a client and model.",
    additionalProperties: false,
  },
);

export const RoleAgent = Type.Union([NonBlankString, InlineAgent], {
  $id: id("config/role-agent"),
  title: "Role agent",
  description: "The name of an `agents` entry, or a complete inline agent.",
});

export const Responsibilities = Type.Array(NonBlankString, {
  description: "Instructions included before stage instructions in every prompt for the role.",
});

export const Description = NonBlankString;

export const RoleEntry = Type.Object(
  {
    description: Type.Optional(nullable(Description)),
    agent: Type.Optional(RoleAgent),
    responsibilities: Type.Optional(nullable(Responsibilities)),
  },
  { $id: id("config/role"), title: "Role", description: "A role: its intent and the agent it uses." },
);

const SchemaVersion = Type.Number({ description: "Document version. The local file's value is ignored." });

export const ConfigLayer = Type.Object(
  {
    schema_version: Type.Optional(SchemaVersion),
    agents: Type.Optional(Type.Record(Type.String(), NamedAgentFragment)),
    roles: Type.Optional(Type.Record(Type.String(), RoleEntry)),
  },
  { $id: id("config/layer"), title: "Config file", description: "`config.yaml` or `config.local.yaml`." },
);

export const EffectiveConfig = Type.Object(
  {
    schema_version: Type.Optional(SchemaVersion),
    agents: Type.Optional(Type.Record(Type.String(), Type.Union([ResolvedAgent, AgentPlaceholder]))),
    roles: Type.Record(Type.String(), RoleEntry),
  },
  { $id: id("config/effective"), title: "Effective config", description: "The config after layers merge." },
);

export type ConfigLayer = Static<typeof ConfigLayer>;
export type EffectiveConfig = Static<typeof EffectiveConfig>;
export type RoleEntry = Static<typeof RoleEntry>;
export type InlineAgent = Static<typeof InlineAgent>;
