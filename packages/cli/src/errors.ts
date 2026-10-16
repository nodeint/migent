export class PromptCancelled extends Error {
  constructor() {
    super("Prompt cancelled.");
    this.name = "PromptCancelled";
  }
}
