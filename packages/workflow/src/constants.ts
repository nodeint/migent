/** Workflow schema versions that introduced a feature. Each is the first version with the feature. */
export const SCHEMA_V2 = 2;
export const SCHEMA_V3 = 3;
/** First version where `requires` is removed and `downstream` exists. */
export const SCHEMA_V4_DOWNSTREAM = 4;
export const SCHEMA_V5 = 5;
/** First version with top-level `artifacts` (and without `outputs`). Fixed: it does not follow the current version. */
export const SCHEMA_V7_ARTIFACTS = 7;

/** Default verify attempts per stage when `max_verify` is not set. */
export const DEFAULT_MAX_VERIFY = 3;
