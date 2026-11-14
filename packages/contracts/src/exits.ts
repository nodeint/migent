import Type, { type Static } from 'typebox';

import { EXIT_FAMILIES,type ExitCodeEntry as ExitCodeEntryData } from './data/exits.js';
import { id } from './schema-id.js';

export type { ExitFamily, ExitName } from './data/exits.js';
export { EXIT_CATALOG, EXIT_FAMILIES, EXIT_FAMILY_TITLES, exitCode, exitLines } from './data/exits.js';

export const ExitCodeEntry = Type.Object(
  {
    code: Type.Integer({ minimum: 0, maximum: 255, description: 'The process exit code.' }),
    name: Type.String({ description: 'Stable name. The stop reason where one exists.' }),
    descriptions: Type.Record(Type.String(), Type.String(), {
      propertyNames: { enum: [...EXIT_FAMILIES] },
      description: 'Per command family: the text that follows `Exit <code> `.',
    }),
  },
  { $id: id('exit/exit-code'), title: 'Exit code', description: 'One exit code and what it means for each command family.' },
);
export type ExitCodeEntry = Static<typeof ExitCodeEntry>;

/** Compile-time check: the plain data interface equals the schema's static type. */
type Equal<A, B> = (<T>() => T extends A ? 'yes' : 'no') extends <T>() => T extends B ? 'yes' : 'no' ? true : false;
const exitCodeEntryTypesMatch: Equal<ExitCodeEntryData, ExitCodeEntry> = true;
void exitCodeEntryTypesMatch;
