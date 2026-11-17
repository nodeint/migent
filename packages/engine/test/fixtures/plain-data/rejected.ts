import { StageOutcome, StreamSummarizer } from '@nodeint/migent-kernel';
import type { SessionStore } from '@nodeint/migent-session';

import type { PlainData } from '../../../src/runtime/plain-data.ts';

declare const outcome: StageOutcome;
declare const summarizer: StreamSummarizer;
declare const store: SessionStore;
declare const callback: () => void;

// @ts-expect-error a class instance with methods is not plain data
export const outcomeIsPlain: PlainData = outcome;
// @ts-expect-error a live summarizer is not plain data
export const summarizerIsPlain: PlainData = summarizer;
// @ts-expect-error a session store is not plain data
export const storeIsPlain: PlainData = store;
// @ts-expect-error a function is not plain data
export const callbackIsPlain: PlainData = callback;
// @ts-expect-error an object with a function member is not plain data
export const holderIsPlain: PlainData = { callback };
// @ts-expect-error undefined is not plain data
export const undefinedIsPlain: PlainData = undefined;
