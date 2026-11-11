/** Compile one `changed_paths` glob. The contract is in docs/workflows.md. */
export function compileChangedPathPattern(pattern: string): { ok: RegExp } | { error: string } {
  if (pattern.includes('\\')) return { error: 'use /' };
  if (pattern.startsWith('/')) return { error: 'patterns are relative to the repository root' };
  if (pattern.startsWith('!')) return { error: 'negative patterns are not supported' };
  if (pattern.endsWith('/')) return { error: 'use dir/**' };
  if (/[[\]{}]/.test(pattern)) return { error: 'character classes and braces are not supported' };
  const segments = pattern.split('/');
  if (segments.some((segment) => segment === '')) return { error: 'empty segment' };
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { error: '. and .. segments are not supported' };
  }
  if (segments.some((segment) => segment !== '**' && segment.includes('**'))) {
    return { error: '** must be a whole segment' };
  }
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment === '**' && parts[parts.length - 1] === '**') continue;
    parts.push(segment);
  }
  let source = '';
  let separator = false;
  parts.forEach((segment, index) => {
    const first = index === 0;
    const last = index === parts.length - 1;
    if (segment === '**') {
      if (first && last) source += '.+';
      else if (first) source += '(?:.+/)?';
      else if (last) source += '(?:/.+)?';
      else source += '/(?:.+/)?';
      separator = false;
      return;
    }
    if (separator) source += '/';
    source += segment
      .split('')
      .map((char) => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
      .join('');
    separator = true;
  });
  return { ok: new RegExp(`^${source}$`, 's') };
}

/** True when `candidate` matches at least one pattern. Invalid patterns match nothing. */
export function matchesChangedPaths(patterns: readonly string[], candidate: string): boolean {
  return patterns.some((pattern) => {
    const compiled = compileChangedPathPattern(pattern);
    return 'ok' in compiled && compiled.ok.test(candidate);
  });
}
