/** HTTP statuses used by the registry service. Shared with the CLI through the package barrel. */
export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_NOT_FOUND = 404;
export const HTTP_METHOD_NOT_ALLOWED = 405;
export const HTTP_CONFLICT = 409;

/** Highest TCP port number. */
export const MAX_PORT = 65_535;

/** Longest accepted request line, in bytes; the reader looks one byte further to detect overflow. */
export const MAX_LINE_BYTES = 65_536;
export const MAX_LINE_PROBE_BYTES = MAX_LINE_BYTES + 1;

/** Field length limits. */
export const MAX_WORKSPACE_NAME_LENGTH = 200;
export const MAX_TOOL_NAME_LENGTH = 80;
export const MAX_TOOL_VERSION_LENGTH = 40;

/** File modes: owner read/write for files, owner-only for directories. */
export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;

/** Process exit status for a bad invocation of the child process. */
export const EXIT_USAGE = 2;

/** Random bytes for secrets (instance id and bearer token). */
export const SECRET_BYTES = 32;

/** Number of hex characters kept from a hash for endpoint names and workspace ids. */
export const ENDPOINT_HASH_LENGTH = 16;
export const WORKSPACE_HASH_LENGTH = 12;

/** Nanoseconds per second, for `process.hrtime`. */
export const NS_PER_SECOND = 1e9;

/** Shortest sleep or probe slice, in seconds. */
export const MIN_POLL_SEC = 0.05;
/** Longest single probe slice, in seconds. */
export const MAX_PROBE_SLICE_SEC = 0.5;
