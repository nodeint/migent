import { ConfigurationError } from '@nodeint/migent-kernel';

export function corrupt(filePath: string, message: string): never {
  throw new ConfigurationError(`Workflow freeze is corrupt: ${filePath} (${message}).`);
}
