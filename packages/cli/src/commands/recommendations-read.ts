import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isValid, SessionRecommendations } from '@nodeint/migent-contracts';
import { NEXT_ARTIFACT_NAME, NEXT_PLUGIN_ID } from '@nodeint/migent-plugins';
import { readWorkflowFreeze } from '@nodeint/migent-session';

import { printNotice } from '../display.js';

type Recommendations = SessionRecommendations['recommendations'];

/** Whether the session's current freeze holds a `next` response contract for at least one stage. */
function freezeHoldsNextContract(sessionDirectory: string): boolean {
  let freeze: ReturnType<typeof readWorkflowFreeze>;
  try {
    freeze = readWorkflowFreeze(sessionDirectory);
  } catch {
    return false;
  }
  if (freeze === null) return false;
  return Object.values(freeze.responseContracts).some((byPlugin) => NEXT_PLUGIN_ID in byPlugin);
}

/**
 * The recommendations the `next` plugin recorded, or `undefined` when the field is absent: the freeze holds no
 * `next` contract, the file is missing, or the file is corrupt (then a notice goes to stderr).
 */
export function readRecommendations(sessionDirectory: string): Recommendations | undefined {
  if (!freezeHoldsNextContract(sessionDirectory)) return undefined;
  const filePath = path.join(sessionDirectory, 'plugins', NEXT_PLUGIN_ID, NEXT_ARTIFACT_NAME);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    printNotice(`Ignoring ${filePath}: it is not valid JSON.`);
    return undefined;
  }
  if (!isValid(SessionRecommendations, parsed)) {
    printNotice(`Ignoring ${filePath}: it does not match the recommendations schema.`);
    return undefined;
  }
  return parsed.recommendations;
}
