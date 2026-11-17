/** Detached data (D9): primitives, arrays, and plain objects only. Classes, functions, and live services never fit. */
export type PlainData =
  | null
  | boolean
  | number
  | string
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

/**
 * Structural check behind the `PlainData` type: every object has the `Object.prototype` or `null` prototype,
 * every array is dense with no extra members, every member is an enumerable data property (no accessors, symbols, or
 * hidden keys), no value is a function, `undefined`, or a non-finite number, and nothing repeats
 * on a path. That makes `JSON.parse(JSON.stringify(value))` deep-equal the value.
 */
export function isPlainData(value: unknown): value is PlainData {
  return isPlainValue(value, new Set());
}

function isPlainValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  // `-0` is finite but JSON turns it into `0`, so it would not round-trip.
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const isPlain = Array.isArray(value) ? isPlainArray(value, ancestors) : isPlainObject(value, ancestors);
  ancestors.delete(value);
  return isPlain;
}

function isPlainArray(value: readonly unknown[], ancestors: Set<object>): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  // Own keys must be exactly the dense indices plus `length`: no holes, extra members, or symbols.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  // Read the length through the intrinsic descriptor and walk plain indices: no method of the candidate is called.
  for (let index = 0; index < value.length; index += 1) {
    if (!hasPlainMember(value, String(index), ancestors)) return false;
  }
  return true;
}

function isPlainObject(value: object, ancestors: Set<object>): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // `Reflect.ownKeys` also lists symbols and non-enumerable members, such as a hidden `toJSON`.
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && hasPlainMember(value, key, ancestors));
}

/** A member counts only as an enumerable own data property: no accessor can run code or change on read. */
function hasPlainMember(owner: object, key: string, ancestors: Set<object>): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor?.enumerable !== true || !('value' in descriptor)) return false;
  return isPlainValue(descriptor.value, ancestors);
}
