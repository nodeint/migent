/** Session manifest `schemaVersion` from which the event log is the source of truth. */
export const MANIFEST_SCHEMA_EVENT_LOG = 2;

/** Zero-padded width of turn numbers and attempt numbers (`01`). */
export const TURN_PAD_WIDTH = 2;
/** Zero-padded width of execution order numbers (`0001`). */
export const ORDER_PAD_WIDTH = 4;
/** First numeric suffix for a duplicate session id (`<id>--02`). */
export const FIRST_SESSION_SUFFIX = 2;
