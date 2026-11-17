import type { PlainData } from '../runtime/plain-data.js';

/** Copies a value through JSON, so the result holds only plain data, exactly what a session file would store. */
export function detach(value: unknown): PlainData {
  return JSON.parse(JSON.stringify(value)) as PlainData;
}

/** `detach` for a value known to be an object. */
export function detachRecord(value: object): { readonly [key: string]: PlainData } {
  return revive<{ readonly [key: string]: PlainData }>(detach(value));
}

/** Reads detached data back as the kernel type it was copied from. Only the boundary that detached it may call this. */
export function revive<T>(data: PlainData): T {
  return data as T;
}

/** A boundary check over one detached member. A missing member is `undefined`, which no check accepts. */
export type Check = (value: PlainData | undefined) => boolean;

type PlainObject = { readonly [key: string]: PlainData };

function isObject(value: PlainData | undefined): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString: Check = (value) => typeof value === 'string';
export const isNumber: Check = (value) => typeof value === 'number';
export const isBoolean: Check = (value) => typeof value === 'boolean';
/** Any present plain value, for a member the operation only carries to a consumer that validates it. */
export const isPresent: Check = (value) => value !== undefined;
export const isRecord: Check = (value) => isObject(value);

export function nullable(check: Check): Check {
  return (value) => value === null || check(value);
}

export function optional(check: Check): Check {
  return (value) => value === undefined || check(value);
}

export function arrayOf(check: Check): Check {
  return (value) => Array.isArray(value) && value.every((item) => check(item));
}

export function oneOf(...allowed: readonly string[]): Check {
  return (value) => typeof value === 'string' && allowed.includes(value);
}

export function either(...checks: readonly Check[]): Check {
  return (value) => checks.some((check) => check(value));
}

/** Every named member present with its check; members not named are not read. */
export function shape(fields: Readonly<Record<string, Check>>): Check {
  return (value) => isObject(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
