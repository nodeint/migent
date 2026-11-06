import type { ProviderResolver, View } from "@nodeint/migent-kernel";
import type { DiscoveryContext } from "./discovery.js";
import type { Column } from "./render.js";

/** Machine types answer from the host, so they take a discovery context instead of a workspace. */
export interface MachineQuery {
  name: string | null;
  client: string | null;
  native: boolean;
}

export interface ProjectResource {
  scope: "project";
  kind: string;
  /** Accepted type names, singular first. */
  names: readonly string[];
  columns: readonly Column[];
  summary: string;
  list?(workspace: string, resolve: ProviderResolver): View[];
  get(workspace: string, name: string | null, resolve: ProviderResolver, session: string | null): View;
}

export interface MachineResource {
  scope: "machine";
  kind: string;
  /** Accepted type names, singular first. */
  names: readonly string[];
  columns: readonly Column[];
  /** Columns for this query when the source changes the shape (for example `options --native`). */
  columnsFor?(query: MachineQuery): readonly Column[];
  summary: string;
  /** Whether `--client` narrows this type. */
  acceptsClient: boolean;
  /** Whether `--native` switches this type's source. */
  acceptsNative: boolean;
  list?(context: DiscoveryContext, query: MachineQuery): Promise<View[]>;
  get(context: DiscoveryContext, query: MachineQuery): Promise<View>;
}

export type Resource = ProjectResource | MachineResource;
