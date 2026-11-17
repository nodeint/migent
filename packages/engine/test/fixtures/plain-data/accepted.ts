import type { PlainData } from '../../../src/runtime/plain-data.ts';

type Detached = { readonly name: string; readonly tags: readonly string[]; readonly nested: { readonly count: number } | null };

export const accepted: PlainData[] = [
  null,
  true,
  1,
  'text',
  ['a', 1],
  { name: 'x', nested: { deep: [null] } },
];
export const detached: Detached = { name: 'x', tags: [], nested: null };
export const detachedAsPlain: PlainData = detached;
