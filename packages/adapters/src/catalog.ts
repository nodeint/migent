export class ModelCatalog {
  readonly ids: readonly string[];
  readonly defaultId: string | null;
  readonly optionValues: ReadonlyArray<readonly [string, string, readonly string[]]>;

  constructor(
    ids: readonly string[],
    defaultId: string | null = null,
    optionValues: ReadonlyArray<readonly [string, string, readonly string[]]> = [],
  ) {
    this.ids = ids;
    this.defaultId = defaultId;
    this.optionValues = optionValues;
  }

  valuesFor(modelId: string, option: string): readonly string[] | null {
    for (const [model, name, values] of this.optionValues) {
      if (model === modelId && name === option) return values;
    }
    return null;
  }
}
