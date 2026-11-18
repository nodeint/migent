/** One note a plugin logged during an invocation. */
export interface PluginNote {
  readonly level: 'info' | 'warn';
  readonly text: string;
}

/**
 * The state of one plugin invocation (activation, or one handler call). Every context member is bound to one of
 * these, so concurrent invocations of the same plugin never share notes or lifetime. The host closes it when the
 * invocation settles, before it applies or discards anything.
 */
export class InvocationState {
  private readonly recorded: PluginNote[] = [];
  private isOpen = true;

  public get open(): boolean {
    return this.isOpen;
  }

  public get notes(): readonly PluginNote[] {
    return [...this.recorded];
  }

  /** A note is accepted only while the invocation's result can still be recorded. */
  public note(level: PluginNote['level'], text: string): void {
    if (this.isOpen) this.recorded.push({ level, text });
  }

  public close(): void {
    this.isOpen = false;
  }
}
