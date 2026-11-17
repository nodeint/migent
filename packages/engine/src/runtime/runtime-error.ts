/** An internal runtime failure: a contract violation by the definition or a handler, never a domain outcome. */
export class RuntimeError extends Error {
  public readonly code: 'unknown_operation' | 'invalid_input' | 'invalid_output' | 'unauthorized_transition' | 'unsupported_variant';

  constructor(code: RuntimeError['code'], message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
