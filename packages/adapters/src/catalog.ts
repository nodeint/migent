export class ModelCatalog {
  public readonly ids: readonly string[];
  public readonly defaultId: string | null;
  public readonly optionValues: readonly (readonly [string, string, readonly string[]])[];

  constructor(
    ids: readonly string[],
    defaultId: string | null = null,
    optionValues: readonly (readonly [string, string, readonly string[]])[] = [],
  ) {
    this.ids = ids;
    this.defaultId = defaultId;
    this.optionValues = optionValues;
  }

  public valuesFor(modelId: string, option: string): readonly string[] | null {
    for (const [model, name, values] of this.optionValues) {
      if (model === modelId && name === option) return values;
    }
    return null;
  }
}
