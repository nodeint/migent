import { parse, YAMLParseError } from 'yaml';

import { ConfigurationError } from './errors.js';

export function parseYamlDocument(text: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const [position, end] = error.linePos ?? [];
      throw new ConfigurationError(error.message, {
        code: error.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'yaml-syntax',
        ...(position === undefined
          ? {}
          : {
              position: {
                line: position.line,
                column: position.col,
                ...(end === undefined ? {} : { end: { line: end.line, column: end.col } }),
              },
            }),
      });
    }
    throw error;
  }
}
