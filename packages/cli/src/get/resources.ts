import {
  createProviderResolver,
  getConfigView,
  getModelView,
  getRoleView,
  getSessionWorkflowView,
  getWorkflowView,
  listModelViews,
  listRoleViews,
  listWorkflowViews,
  ConfigurationError,
  type ProviderResolver,
  type View,
} from "@nodeint/migent-kernel";
import { providerMap } from "../provider.js";
import { cell, type Column } from "./render.js";

export interface Resource {
  kind: string;
  /** Accepted type names, singular first. */
  names: readonly string[];
  columns: readonly Column[];
  summary: string;
  list?(workspace: string, resolve: ProviderResolver): View[];
  get(workspace: string, name: string | null, resolve: ProviderResolver, session: string | null): View;
}

const field = (header: string, key: string): Column => ({ header, cell: (view) => cell(view[key]) });
const targetField = (header: string, key: string): Column => ({
  header,
  cell: (view) => {
    const target = view.target;
    return typeof target === "object" && target !== null ? cell((target as Record<string, unknown>)[key]) : "-";
  },
});
const count = (header: string, key: string): Column => ({
  header,
  cell: (view) => (Array.isArray(view[key]) ? String((view[key] as unknown[]).length) : "0"),
});

function requireName(label: string, name: string | null): string {
  if (name === null) throw new ConfigurationError(`Pass a ${label} name.`);
  return name;
}

export const RESOURCES: readonly Resource[] = [
  {
    kind: "workflow",
    names: ["workflow", "workflows", "wf"],
    summary: "Workflows in .migent/workflows, or one session's workflow with --session.",
    columns: [field("NAME", "name"), field("FILE", "file"), field("STAGES", "stages"), field("ROLES", "roles"), count("PROBLEMS", "problems")],
    list: (workspace) => listWorkflowViews(workspace),
    get: (workspace, name, resolve, session) =>
      session !== null
        ? getSessionWorkflowView(workspace, session, name, resolve)
        : getWorkflowView(workspace, requireName("workflow", name), resolve),
  },
  {
    kind: "role",
    names: ["role", "roles"],
    summary: "Roles in the effective config with their resolved model.",
    columns: [field("NAME", "name"), field("DEFAULT_MODEL", "default_model"), targetField("PROVIDER", "provider"), targetField("MODEL", "model"), count("PROBLEMS", "problems")],
    list: (workspace, resolve) => listRoleViews(workspace, resolve),
    get: (workspace, name, resolve) => getRoleView(workspace, requireName("role", name), resolve),
  },
  {
    kind: "model",
    names: ["model", "models"],
    summary: "Model aliases the project names (not the provider catalog; see `migent provider list`).",
    columns: [field("NAME", "name"), field("PROVIDER", "provider"), field("MODEL", "model"), field("LOCAL", "local"), count("PROBLEMS", "problems")],
    list: (workspace, resolve) => listModelViews(workspace, resolve),
    get: (workspace, name, resolve) => getModelView(workspace, requireName("model", name), resolve),
  },
  {
    kind: "config",
    names: ["config"],
    summary: "The effective config: config.yaml with config.local.yaml merged over it.",
    columns: [],
    get: (workspace) => getConfigView(workspace),
  },
];

export function findResource(type: string): Resource | undefined {
  return RESOURCES.find((resource) => resource.names.includes(type));
}

export function resourceTypes(): string {
  return RESOURCES.map((resource) => resource.names.slice(0, 2).join("|")).join(", ");
}

/** Pure lookup: resolving a provider never spawns a CLI. */
export function providerResolver(): ProviderResolver {
  return createProviderResolver(providerMap());
}
