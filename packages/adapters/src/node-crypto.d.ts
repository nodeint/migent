declare module 'node:crypto' {
  export function randomUUID(): string;
  export function randomBytes(size: number): Uint8Array;
}
