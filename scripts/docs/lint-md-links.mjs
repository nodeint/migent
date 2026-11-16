#!/usr/bin/env node
/**
 * Scan markdown files for broken in-repo links (files, dirs, heading fragments).
 *
 * Usage:
 *   node scripts/docs/lint-md-links.mjs
 *   node scripts/docs/lint-md-links.mjs --path docs
 *   node scripts/docs/lint-md-links.mjs docs .agents
 *   node scripts/docs/lint-md-links.mjs --json
 *   node scripts/docs/lint-md-links.mjs --no-fragments
 *   node scripts/docs/lint-md-links.mjs --no-symbols
 *   node scripts/docs/lint-md-links.mjs --http
 *   node scripts/docs/lint-md-links.mjs --self-test
 *
 * Default: walk the repo, check local targets, exit 1 when findings > 0.
 * Skips Git-ignored files and paths in the `ignores` list of `.markdownlint-cli2.jsonc`.
 * `--http` also HEAD/GET `http(s):` URLs (slow; network).
 * A link whose text is one backticked identifier (`Name` or `Owner.member`) to a code file
 * must find that name (the last segment) as a whole word in the file, or it is a `missing-symbol`.
 * `--no-symbols` skips that check.
 * Heading fragments use GFM / github-slugger (`Phase 2 — Align` → `phase-2--align`).
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from '../lib/repo.mjs';

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.git',
  '.next',
  '.cache',
  'out',
]);

/**
 * Turn the `ignores` globs of `.markdownlint-cli2.jsonc` into path prefixes,
 * so markdownlint and this script skip the same paths.
 * Only `dir/**` and plain paths are supported; any other glob throws instead of being skipped silently.
 *
 * @param {string} configPath
 * @returns {string[]}
 */
function readMarkdownlintIgnorePrefixes(configPath) {
  const text = readFileSync(configPath, 'utf8')
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ''))
    .replace(/,(\s*[\]}])/g, '$1');
  const ignores = JSON.parse(text).ignores ?? [];
  return ignores.map((glob) => {
    const prefix = glob.endsWith('/**') ? glob.slice(0, -3) : glob;
    if (/[*?[\]{}!]/.test(prefix)) {
      throw new Error(`lint-md-links: unsupported ignore glob in .markdownlint-cli2.jsonc: ${glob}`);
    }
    return prefix;
  });
}

const SKIP_PATH_PREFIXES = [
  ...readMarkdownlintIgnorePrefixes(join(REPO_ROOT, '.markdownlint-cli2.jsonc')),
];

const REMOTE_SCHEMES = new Set(['http', 'https']);
const SKIP_SCHEMES = new Set([
  'mailto',
  'tel',
  'data',
  'javascript',
  'vscode',
  'file',
]);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);
const SYMBOL_TEXT = /^`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`$/;
const FILE_NAME_TEXT = /\.(?:[cm]?[jt]sx?|json|css|md)$/;

const HTTP_TIMEOUT_MS = 8000;
const HTTP_CONCURRENCY = 8;

const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function flagValues(name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function positionalPaths() {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--path' && args[i + 1] && !args[i + 1].startsWith('--')) {
      i += 1;
      continue;
    }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

function posixRel(from, to) {
  return relative(from, to).split(sep).join('/');
}

function underRoot(root, abs) {
  const rel = posixRel(root, abs);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

async function pathStat(abs) {
  try {
    return await stat(abs);
  } catch {
    return null;
  }
}

function normalizePrefix(p) {
  return p.endsWith('/') ? p : `${p}/`;
}

function isExplicitlyRequested(rel, requestedRels) {
  return requestedRels.some((req) => {
    if (!req || req === '.') return false;
    const r = normalizePrefix(req);
    const target = normalizePrefix(rel);
    return target === r || target.startsWith(r) || r.startsWith(target);
  });
}

function shouldSkipRel(rel, requestedRels) {
  return SKIP_PATH_PREFIXES.some((prefix) => {
    const p = normalizePrefix(prefix);
    if (rel !== p.slice(0, -1) && !rel.startsWith(p)) return false;
    return !isExplicitlyRequested(rel, requestedRels);
  });
}

async function walkMarkdown(dir, root, files, requestedRels) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = posixRel(root, full);
    if (shouldSkipRel(rel, requestedRels)) continue;
    if (entry.isDirectory()) {
      await walkMarkdown(full, root, files, requestedRels);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(full);
    }
  }
}

function stripYamlFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return content;
  const after = content.slice(end + 4);
  if (!after.startsWith('\n') && after.length > 0) return content;
  const removed = content.slice(0, end + 4);
  const newlines = (removed.match(/\n/g) ?? []).length;
  return `${'\n'.repeat(newlines)}${after.startsWith('\n') ? after.slice(1) : after}`;
}

function isFenceOpen(line) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length };
}

function isFenceClose(line, fence) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  if (!m) return false;
  return m[1][0] === fence.char && m[1].length >= fence.len;
}

function maskInlineCode(line) {
  return line.replace(/(`+)((?:(?!\1).)*?)\1/g, (match) => ' '.repeat(match.length));
}

function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
}

function splitHref(raw) {
  let href = raw.trim();
  if (href.startsWith('<') && href.endsWith('>')) {
    href = href.slice(1, -1).trim();
  }
  const hashAt = href.indexOf('#');
  const pathWithQuery = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const frag = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  const qAt = pathWithQuery.indexOf('?');
  const pathPart = qAt >= 0 ? pathWithQuery.slice(0, qAt) : pathWithQuery;
  return { pathPart, frag };
}

function hrefScheme(href) {
  const m = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return m ? m[1].toLowerCase() : null;
}

function parseInlineDest(src, start) {
  let i = start;
  while (src[i] === ' ' || src[i] === '\t') i += 1;
  if (i >= src.length) return null;
  if (src[i] === '<') {
    const end = src.indexOf('>', i + 1);
    if (end < 0) return null;
    const dest = src.slice(i + 1, end);
    i = end + 1;
    while (src[i] === ' ' || src[i] === '\t') i += 1;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      const qEnd = src.indexOf(q, i + 1);
      if (qEnd < 0) return null;
      i = qEnd + 1;
      while (src[i] === ' ' || src[i] === '\t') i += 1;
    }
    if (src[i] !== ')') return null;
    return { dest, end: i + 1 };
  }
  let depth = 1;
  let destStart = i;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        let dest = src.slice(destStart, i).trim();
        const title = dest.match(/^(.*?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/);
        if (title) dest = title[1];
        return { dest, end: i + 1 };
      }
    }
    i += 1;
  }
  return null;
}

function findMatchingBracket(src, openAt) {
  let depth = 0;
  for (let i = openAt; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function forEachUnfencedLine(lines, visit) {
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = isFenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    visit(line, i);
  }
}

function collectReferenceDefs(lines) {
  /** @type {Map<string, { href: string, line: number }>} */
  const refs = new Map();
  forEachUnfencedLine(lines, (line, i) => {
    const m = line.match(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/);
    if (!m) return;
    refs.set(m[1].trim().toLowerCase(), { href: m[2].replace(/^<|>$/g, ''), line: i + 1 });
  });
  return refs;
}

function extractLinksFromLine(line, lineNo, refs, out) {
  const masked = maskInlineCode(line);
  let i = 0;
  while (i < masked.length) {
    const bang = masked[i] === '!' && masked[i + 1] === '[';
    if (masked[i] !== '[' && !bang) {
      i += 1;
      continue;
    }
    const open = bang ? i + 1 : i;
    if (open > 0 && masked[open - 1] === '[') {
      i += 1;
      continue;
    }
    const close = findMatchingBracket(masked, open);
    if (close < 0) {
      i += 1;
      continue;
    }
    const text = masked.slice(open + 1, close);
    const after = close + 1;
    if (masked[after] === '(') {
      const dest = parseInlineDest(masked, after + 1);
      if (dest) {
        out.push({ text, rawText: line.slice(open + 1, close), href: dest.dest, line: lineNo });
        i = dest.end;
        continue;
      }
    }
    if (masked[after] === '[') {
      const refClose = findMatchingBracket(masked, after);
      if (refClose >= 0) {
        const key = (masked.slice(after + 1, refClose).trim() || text).toLowerCase();
        const def = refs.get(key);
        if (def) out.push({ text, href: def.href, line: lineNo });
        i = refClose + 1;
        continue;
      }
    }
    i += 1;
  }
}

function extractLinks(content) {
  const prepared = stripHtmlComments(stripYamlFrontmatter(content));
  const lines = prepared.split(/\r?\n/);
  const refs = collectReferenceDefs(lines);
  /** @type {Array<{ text: string, rawText?: string, href: string, line: number }>} */
  const links = [];
  forEachUnfencedLine(lines, (line, i) => {
    extractLinksFromLine(line, i + 1, refs, links);
  });
  return links;
}

function headingPlainText(raw) {
  let t = raw.trim().replace(/\s+#+\s*$/, '');
  t = t.replace(/\s*\{#([^}]+)\}\s*$/, '');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/<\/?[^>]+>/g, '');
  t = t.replace(/[`*_~]+/g, '');
  return t.trim();
}

function headingExplicitId(raw) {
  const m = raw.trim().replace(/\s+#+\s*$/, '').match(/\{#([^}]+)\}\s*$/);
  return m ? m[1] : null;
}

function githubSlug(value) {
  return value
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

function collectHeadingIds(content) {
  const prepared = stripHtmlComments(stripYamlFrontmatter(content));
  const lines = prepared.split(/\r?\n/);
  const ids = new Set();
  const seen = new Map();

  const addSlug = (slug) => {
    if (!slug) return;
    const count = seen.get(slug) ?? 0;
    const id = count === 0 ? slug : `${slug}-${count}`;
    seen.set(slug, count + 1);
    ids.add(id);
  };

  forEachUnfencedLine(lines, (line, i) => {
    for (const m of line.matchAll(/\bid=["']([^"']+)["']/gi)) ids.add(m[1]);
    for (const m of line.matchAll(/\bname=["']([^"']+)["']/gi)) ids.add(m[1]);

    const atx = line.match(/^ {0,3}(#{1,6})\s+(.+)$/);
    if (atx) {
      const explicit = headingExplicitId(atx[2]);
      if (explicit) ids.add(explicit);
      addSlug(githubSlug(headingPlainText(atx[2])));
      return;
    }

    const next = lines[i + 1];
    if (next && /^ {0,3}(=+|-+)\s*$/.test(next) && line.trim()) {
      const explicit = headingExplicitId(line);
      if (explicit) ids.add(explicit);
      addSlug(githubSlug(headingPlainText(line)));
    }
  });
  return ids;
}

function decodePath(pathPart) {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function hasExtension(pathPart) {
  const base = pathPart.split('/').pop() ?? '';
  return base.includes('.');
}

/**
 * @param {string} fromFile
 * @param {string} pathPart
 * @param {string} root
 */
async function resolveLocalTarget(fromFile, pathPart, root) {
  if (!pathPart || pathPart === '.') {
    return { abs: fromFile, kind: /** @type {const} */ ('file') };
  }

  const decoded = decodePath(pathPart);

  /** @param {string} abs */
  async function finish(abs) {
    if (!underRoot(root, abs)) {
      return { abs, kind: /** @type {const} */ ('outside') };
    }
    const st = await pathStat(abs);
    if (st?.isFile()) return { abs, kind: /** @type {const} */ ('file') };
    if (st?.isDirectory()) return { abs, kind: /** @type {const} */ ('dir') };
    if (!hasExtension(decoded.replace(/[/\\]+$/, ''))) {
      const asMd = await pathStat(`${abs}.md`);
      if (asMd?.isFile()) return { abs: `${abs}.md`, kind: /** @type {const} */ ('file') };
      const readme = await pathStat(join(abs, 'README.md'));
      if (readme?.isFile()) return { abs: join(abs, 'README.md'), kind: /** @type {const} */ ('file') };
    }
    return { abs, kind: /** @type {const} */ ('missing') };
  }

  if (isAbsolute(decoded)) {
    const direct = await pathStat(decoded);
    if (direct?.isFile()) return { abs: decoded, kind: /** @type {const} */ ('file') };
    if (direct?.isDirectory()) return { abs: decoded, kind: /** @type {const} */ ('dir') };
    return finish(resolve(root, decoded.replace(/^[/\\]+/, '')));
  }

  return finish(resolve(dirname(fromFile), decoded));
}

async function fragmentTargetFile(resolved) {
  if (resolved.kind === 'file') return resolved.abs;
  if (resolved.kind === 'dir') {
    const readme = join(resolved.abs, 'README.md');
    const st = await pathStat(readme);
    return st?.isFile() ? readme : null;
  }
  return null;
}

const headingCache = new Map();

async function headingIdsFor(file) {
  const cached = headingCache.get(file);
  if (cached) return cached;
  const content = await readFile(file, 'utf8');
  const ids = collectHeadingIds(content);
  headingCache.set(file, ids);
  return ids;
}

/**
 * The name a link text claims to be a symbol: the last segment of a backticked identifier,
 * or null when the text is anything else, including a file name such as `api.ts`.
 *
 * @param {string | undefined} rawText
 * @returns {string | null}
 */
function symbolFromLinkText(rawText) {
  const m = rawText?.trim().match(SYMBOL_TEXT);
  if (!m || FILE_NAME_TEXT.test(m[1])) return null;
  return m[1].split('.').pop() ?? null;
}

const fileTextCache = new Map();

async function fileTextFor(file) {
  const cached = fileTextCache.get(file);
  if (cached !== undefined) return cached;
  const text = await readFile(file, 'utf8');
  fileTextCache.set(file, text);
  return text;
}

async function checkHttp(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const headers = { 'user-agent': 'nodeint-markdown-link-check' };
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers,
      });
    }
    return { status: res.status, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/**
 * @param {{ root: string, walkFrom: string[], checkFragments: boolean, checkSymbols: boolean, checkHttp: boolean }} opts
 */
async function scan(opts) {
  const { root, walkFrom, checkFragments, checkSymbols, checkHttp: wantHttp } = opts;
  const requestedRels = walkFrom.map((start) => posixRel(root, start) || '.');
  /** @type {string[]} */
  let files = [];
  for (const start of walkFrom) {
    const st = await pathStat(start);
    if (!st) continue;
    if (st.isFile()) {
      if (start.toLowerCase().endsWith('.md')) files.push(start);
      continue;
    }
    await walkMarkdown(start, root, files, requestedRels);
  }

  if (files.length > 0) {
    const result = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: root,
      input: files.map((file) => posixRel(root, file)).join('\0') + '\0',
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore failed: ${result.stderr}`);
    }
    const ignored = new Set(result.stdout.split('\0').filter(Boolean));
    files = files.filter((file) => !ignored.has(posixRel(root, file)));
  }

  /** @type {Array<{ file: string, line: number, text: string, href: string, kind: string, target: string, detail: string }>} */
  const findings = [];
  /** @type {Array<{ file: string, line: number, text: string, href: string }>} */
  const remote = [];
  let checkedLinks = 0;

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const links = extractLinks(content);
    for (const link of links) {
      const href = link.href.trim();
      if (!href) {
        checkedLinks += 1;
        findings.push({
          file: posixRel(root, file),
          line: link.line,
          text: link.text,
          href,
          kind: 'empty',
          target: '',
          detail: 'empty destination',
        });
        continue;
      }

      const scheme = hrefScheme(href);
      if (scheme && SKIP_SCHEMES.has(scheme)) continue;
      if (scheme && REMOTE_SCHEMES.has(scheme)) {
        if (wantHttp) remote.push({ file: posixRel(root, file), line: link.line, text: link.text, href });
        continue;
      }
      if (scheme) continue;

      checkedLinks += 1;
      const { pathPart, frag } = splitHref(href);
      const resolved = await resolveLocalTarget(file, pathPart, root);

      if (resolved.kind === 'outside') {
        findings.push({
          file: posixRel(root, file),
          line: link.line,
          text: link.text,
          href,
          kind: 'outside-repo',
          target: posixRel(root, resolved.abs),
          detail: 'resolves outside the scan root',
        });
        continue;
      }

      if (resolved.kind === 'missing') {
        findings.push({
          file: posixRel(root, file),
          line: link.line,
          text: link.text,
          href,
          kind: 'missing-file',
          target: posixRel(root, resolved.abs),
          detail: 'file or directory does not exist',
        });
        continue;
      }

      const symbol = checkSymbols && resolved.kind === 'file' && CODE_EXTENSIONS.has(extname(resolved.abs))
        ? symbolFromLinkText(link.rawText)
        : null;
      if (symbol && !new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`).test(await fileTextFor(resolved.abs))) {
        findings.push({
          file: posixRel(root, file),
          line: link.line,
          text: link.text,
          href,
          kind: 'missing-symbol',
          target: posixRel(root, resolved.abs),
          detail: `symbol "${symbol}" not found in the file`,
        });
        continue;
      }

      if (!checkFragments || !frag) continue;

      const fragFile = await fragmentTargetFile(resolved);
      if (!fragFile) {
        findings.push({
          file: posixRel(root, file),
          line: link.line,
          text: link.text,
          href,
          kind: 'missing-fragment',
          target: `${posixRel(root, resolved.abs)}#${frag}`,
          detail: 'directory has no README.md to resolve the heading',
        });
        continue;
      }

      const ids = await headingIdsFor(fragFile);
      const decodedFrag = decodePath(frag);
      if (!ids.has(decodedFrag)) {
        findings.push({
          file: posixRel(root, file),
          line: link.line,
          text: link.text,
          href,
          kind: 'missing-fragment',
          target: `${posixRel(root, fragFile)}#${decodedFrag}`,
          detail: 'heading id not found',
        });
      }
    }
  }

  if (wantHttp && remote.length > 0) {
    await mapPool(remote, HTTP_CONCURRENCY, async (item) => {
      checkedLinks += 1;
      const result = await checkHttp(item.href);
      const ok = result.status >= 200 && result.status < 400;
      if (ok) return;
      findings.push({
        file: item.file,
        line: item.line,
        text: item.text,
        href: item.href,
        kind: 'http',
        target: item.href,
        detail: result.error ? result.error : `HTTP ${result.status}`,
      });
    });
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { files: files.length, checkedLinks, findings };
}

function printHuman(result) {
  if (result.findings.length === 0) {
    console.log(`Markdown links ok — ${result.files} files, ${result.checkedLinks} local targets.`);
    return;
  }
  console.error(`Broken markdown links (${result.findings.length}):\n`);
  for (const f of result.findings) {
    const label = f.text.trim() ? `"${f.text.trim()}"` : '(no text)';
    console.error(`  • ${f.file}:${f.line}  ${label} → ${f.href}`);
    console.error(`      ${f.kind}: ${f.detail}${f.target ? ` (${f.target})` : ''}`);
  }
}

function expect(cond, message, errors) {
  if (!cond) errors.push(message);
}

async function runSelfTest() {
  const dir = await mkdtemp(join(tmpdir(), 'md-links-'));
  const errors = [];
  try {
    const init = spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' });
    if (init.error) throw init.error;
    if (init.status !== 0) throw new Error(init.stderr);
    writeFileSync(join(dir, '.gitignore'), 'ignored.md\n');
    writeFileSync(join(dir, 'ignored.md'), '[ignored](./ignored-missing.md)\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', '.gitignore'), '*.md\n!README.md\n');
    writeFileSync(join(dir, 'sub', 'ignored.md'), '[nested](./nested-missing.md)\n');
    writeFileSync(join(dir, 'ok.md'), '# Hello world\n\n## Dup\n\n## Dup\n');
    writeFileSync(join(dir, 'windows.md'), '# Windows heading\r\n\r\n## Windows child\r\n');
    writeFileSync(join(dir, 'sub', 'README.md'), '# Sub home\n');
    writeFileSync(join(dir, 'code.ts'), 'export function present(): void {}\n');
    const absTarget = join(dir, 'ok.md');
    writeFileSync(
      join(dir, 'src.md'),
      [
        '[ok](./ok.md)',
        '[ok heading](./ok.md#hello-world)',
        '[Windows heading](./windows.md#windows-heading)',
        '[Windows child](./windows.md#windows-child)',
        '[dup1](./ok.md#dup-1)',
        '[dir](./sub/)',
        '[dir heading](./sub/#sub-home)',
        '[bare](./ok)',
        `[abs](${absTarget})`,
        '[missing](./nope.md)',
        '[bad frag](./ok.md#no-such)',
        '[ref missing][gone]',
        '[gone]: ./also-missing.md',
        '',
        '```',
        '[fake](./not-real.md)',
        '```',
        '',
        'inline `[fake](./also-not.md)` still hidden',
        '',
        '[`present`](./code.ts)',
        '[`Owner.present`](./code.ts)',
        '[`gone`](./code.ts)',
        '[`Owner.gone`](./code.ts)',
        '[`prefixpresent`](./code.ts)',
        '[`code.ts`](./code.ts)',
        '[`two words`](./code.ts)',
        '[`gone`](./ok.md)',
        '[`gone`](./sub/)',
        '[ext](https://example.invalid/skip-by-default)',
        '',
        '<!-- [comment](./comment-missing.md) -->',
      ].join('\n'),
    );

    const result = await scan({
      root: dir,
      walkFrom: [dir],
      checkFragments: true,
      checkSymbols: true,
      checkHttp: false,
    });

    const kinds = result.findings.map((f) => `${f.kind}:${f.href}`).sort();
    expect(result.files === 4, `expected 4 non-ignored Markdown files, got ${result.files}`, errors);
    expect(!kinds.some((kind) => kind.includes('ignored-missing') || kind.includes('nested-missing')),
      'Git-ignored files must not contribute findings', errors);
    expect(
      kinds.includes('missing-file:./nope.md'),
      `expected missing-file ./nope.md, got ${kinds.join(', ')}`,
      errors,
    );
    expect(
      kinds.includes('missing-file:./also-missing.md'),
      'expected reference definition target to be checked',
      errors,
    );
    expect(
      kinds.includes('missing-fragment:./ok.md#no-such'),
      'expected missing fragment',
      errors,
    );
    expect(
      !kinds.some((k) => k.includes('not-real.md') || k.includes('also-not.md') || k.includes('comment-missing')),
      'fenced / inline-code / comment links must be ignored',
      errors,
    );
    expect(
      !kinds.some((k) => k.includes('example.invalid')),
      'http links must be skipped without --http',
      errors,
    );
    const symbolHrefs = result.findings.filter((f) => f.kind === 'missing-symbol').map((f) => f.detail.match(/"(.+?)"/)[1]).sort();
    expect(
      symbolHrefs.join(',') === 'gone,gone,prefixpresent',
      `expected missing-symbol for gone, Owner.gone, prefixpresent only, got ${symbolHrefs.join(', ')}`,
      errors,
    );
    expect(
      result.findings.every((f) => ['missing-file', 'missing-fragment', 'missing-symbol'].includes(f.kind)),
      `unexpected finding kinds: ${kinds.join(', ')}`,
      errors,
    );
    const missingCount = result.findings.filter((f) => f.kind === 'missing-file').length;
    const fragCount = result.findings.filter((f) => f.kind === 'missing-fragment').length;
    expect(missingCount === 2, `expected 2 missing-file, got ${missingCount}`, errors);
    expect(fragCount === 1, `expected 1 missing-fragment, got ${fragCount}`, errors);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (errors.length > 0) {
    console.error('lint-md-links self-test failed:\n');
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }
  console.log('lint-md-links self-test passed.');
}

function resolveWalkPaths(root) {
  const requested = [...flagValues('--path'), ...positionalPaths()];
  if (requested.length === 0) return [root];
  return requested.map((p) => (isAbsolute(p) ? p : resolve(root, p)));
}

async function main() {
  if (hasFlag('--self-test')) {
    await runSelfTest();
    return;
  }

  const walkFrom = resolveWalkPaths(REPO_ROOT);
  const result = await scan({
    root: REPO_ROOT,
    walkFrom,
    checkFragments: !hasFlag('--no-fragments'),
    checkSymbols: !hasFlag('--no-symbols'),
    checkHttp: hasFlag('--http'),
  });

  if (hasFlag('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (result.findings.length > 0) process.exit(1);
}

await main();
