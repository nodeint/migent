import type { Static, TSchema } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';

import type { DiscoveryContext } from './discovery.js';
import type { Column } from './render.js';

/** Machine types answer from the host, so they take a discovery context instead of a workspace. */
export interface MachineQuery {
  name: string | null;
  client: string | null;
  native: boolean;
}

/**
 * `One` is the contract of a single view, `Item` the contract of a list item (the same unless a
 * list shows summaries). The views a resource returns are typed from them, so a view that does not
 * match its contract does not compile. Kernel views are asserted at this boundary with `asView`.
 */
export interface ProjectResource<One extends TSchema = TSchema, Item extends TSchema = One> {
  scope: 'project';
  kind: string;
  /** Accepted type names, singular first. */
  names: readonly string[];
  columns: readonly Column[];
  contract: One;
  listContract: Item;
  summary: string;
  list?(workspace: string, resolve: ClientRegistry): Static<Item>[];
  get(workspace: string, name: string | null, resolve: ClientRegistry, session: string | null): Static<One>;
}

export interface MachineResource<One extends TSchema = TSchema, Item extends TSchema = One> {
  scope: 'machine';
  kind: string;
  /** Accepted type names, singular first. */
  names: readonly string[];
  columns: readonly Column[];
  /** Columns for this query when the source changes the shape (for example `options --native`). */
  columnsFor?(query: MachineQuery): readonly Column[];
  contract: One;
  listContract: Item;
  /** The contract for this query when it is narrower than `contract` (for example `options --native`). */
  contractFor?(query: MachineQuery): { one: TSchema; item: TSchema };
  summary: string;
  /** Whether `--client` narrows this type. */
  acceptsClient: boolean;
  /** Whether `--native` switches this type's source. */
  acceptsNative: boolean;
  list?(context: DiscoveryContext, query: MachineQuery): Promise<Static<Item>[]>;
  get(context: DiscoveryContext, query: MachineQuery): Promise<Static<One>>;
}

export type Resource = ProjectResource | MachineResource;

/** Asserts that a view built by another package matches the contract the CLI publishes for it. */
export function asView<S extends TSchema>(_contract: S, view: unknown): Static<S> {
  return view as Static<S>;
}
