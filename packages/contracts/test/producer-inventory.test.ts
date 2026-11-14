import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, describe, expect, test } from 'vitest';

import { SESSION_EVENT_TEMPLATES, SESSION_EVENTS, SESSION_FILE_EXCLUSIONS, SESSION_FILES } from '../src/index.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = ['session', 'engine', 'kernel', 'adapters', 'cli'];

/** Heads that mark a string as event-shaped: `<family>.<name>`. */
const FAMILIES = 'session|execution|stage|provider|verify|resume|workflow|task|response|question|handoff|correction|baseline|outputs|revisions';
const EVENT_SHAPE = new RegExp(`^(${FAMILIES})\\.[a-z][a-z_]*$`);
const FILE_EXTENSIONS = new Set(['json', 'jsonl', 'md', 'yaml', 'yml', 'lock', 'ts', 'js', 'txt', 'log', 'requested']);
const TEMPLATE_HEAD = new RegExp(`^(${FAMILIES})\\.$`);
const SESSION_FILE_SHAPE = /^[A-Za-z0-9_.-]+\.(json|jsonl|yaml|lock|requested)$/;

/** Event-shaped strings that are not events. Each entry needs a reason. */
const EVENT_ALLOW_LIST: readonly { value: string; reason: string }[] = [
  { value: 'session.on_expired', reason: 'Config key of a stage, not an event.' },
  { value: 'session.resume_from', reason: 'Config key, not an event.' },
  { value: 'session.interrupt', reason: 'Argument string of the opencode CLI, not a Migent event.' },
  { value: 'provider.item_', reason: 'Prefix of the adapter item event names; each full name is registered.' },
];

const eventNames = new Set(SESSION_EVENTS.map((entry) => entry.event));
const knownFiles = new Set([
  ...SESSION_FILES.map((entry) => path.basename(entry.path)),
  ...SESSION_FILE_EXCLUSIONS.map((entry) => entry.name),
]);

interface Config {
  readonly names: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
  readonly allow: readonly { value: string }[];
  readonly templates: readonly { file: string; head: string }[];
}
interface Result { violations: string[]; unchecked: number; templatesSeen: string[] }

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function program(files: string[]): ts.Program {
  const paths: Record<string, string[]> = {};
  for (const name of ['contracts', 'workflow', 'adapters', 'prompts', 'doctor', 'kernel', 'session', 'engine', 'registry']) {
    paths[`@nodeint/migent-${name}`] = [path.join(repo, 'packages', name, 'src', 'index.ts')];
  }
  return ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noEmit: true, skipLibCheck: true, baseUrl: repo, paths, types: ['node'],
    typeRoots: [path.join(repo, 'node_modules', '@types')], allowImportingTsExtensions: true,
  });
}

function literalMembers(type: ts.Type): string[] | null {
  const parts = type.isUnion() ? type.types : [type];
  const out: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteral()) return null;
    out.push(part.value);
  }
  return out;
}

function analyze(files: string[], config: Config): Result {
  const built = program(files);
  const checker = built.getTypeChecker();
  const result: Result = { violations: [], unchecked: 0, templatesSeen: [] };
  const allowed = new Set(config.allow.map((entry) => entry.value));
  for (const file of files) {
    const source = built.getSourceFile(file);
    if (source === undefined) throw new Error(`not parsed: ${file}`);
    const relative = path.relative(repo, file).split(path.sep).join('/');
    const where = (node: ts.Node) => `${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    result.unchecked += (source.text.match(/\/\/ event-template: unchecked/g) ?? []).length;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node, node.text);
      if (ts.isTemplateExpression(node)) template(node);
      ts.forEachChild(node, visit);
    };
    const literal = (node: ts.Node, text: string): void => {
      const extension = text.split('.').at(-1) ?? '';
      if (EVENT_SHAPE.test(text) && !FILE_EXTENSIONS.has(extension) && !allowed.has(text) && !config.names.has(text)) {
        result.violations.push(`${where(node)} unregistered event literal ${JSON.stringify(text)}`);
      }
      if (SESSION_FILE_SHAPE.test(text) && !config.files.has(text)) {
        result.violations.push(`${where(node)} unregistered session file ${JSON.stringify(text)}`);
      }
    };
    const template = (node: ts.TemplateExpression): void => {
      const head = node.head.text;
      if (!TEMPLATE_HEAD.test(head) || node.templateSpans.length !== 1 || node.templateSpans[0].literal.text !== '') return;
      if (!config.templates.some((entry) => entry.file === relative && entry.head === head)) {
        result.violations.push(`${where(node)} unregistered template head ${JSON.stringify(head)}`);
        return;
      }
      result.templatesSeen.push(`${relative}|${head}`);
      const members = literalMembers(checker.getTypeAtLocation(node.templateSpans[0].expression));
      if (members === null) {
        result.violations.push(`${where(node)} template suffix of ${JSON.stringify(head)} is not a union of string literals`);
        return;
      }
      for (const member of members) {
        if (!config.names.has(`${head}${member}`)) result.violations.push(`${where(node)} unregistered event ${head}${member}`);
      }
    };
    visit(source);
  }
  return result;
}

const real: Config = {
  names: eventNames, files: knownFiles, allow: EVENT_ALLOW_LIST,
  templates: SESSION_EVENT_TEMPLATES.map((entry) => ({ file: entry.file, head: entry.head })),
};

describe('producer inventory (D7)', () => {
  const files = PACKAGES.flatMap((name) => sourceFiles(path.join(repo, 'packages', name, 'src')));
  const result = analyze(files, real);

  test('every event literal, template and session file in producer sources is registered', () => {
    expect(result.violations).toEqual([]);
  });

  test('every registered template is used by its producer', () => {
    expect(new Set(result.templatesSeen)).toEqual(new Set(SESSION_EVENT_TEMPLATES.map((entry) => `${entry.file}|${entry.head}`)));
  });

  test('the allow-list is short and every entry has a reason', () => {
    expect(EVENT_ALLOW_LIST.length).toBeLessThanOrEqual(6);
    for (const entry of EVENT_ALLOW_LIST) expect(entry.reason.length).toBeGreaterThan(10);
  });

  test('unchecked event-template casts stay few', () => {
    expect(result.unchecked).toBeGreaterThan(0);
    expect(result.unchecked).toBeLessThanOrEqual(12);
  });
});

describe('negative fixtures fail for the expected reason', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'migent-inventory-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const check = (name: string, text: string, templates: Config['templates'] = []): Result => {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${name}.ts`);
    writeFileSync(file, text);
    return analyze([file], { ...real, templates });
  };

  test('an unregistered literal in a conditional', () => {
    expect(check('a', "export const x = (flag: boolean) => (flag ? 'session.bogus' : 'session.completed');").violations.join()).toMatch(/unregistered event literal "session.bogus"/);
  });
  test('an unregistered literal in a variable', () => {
    expect(check('b', "const name = 'verify.bogus'; export default name;").violations.join()).toMatch(/verify.bogus/);
  });
  test('an unregistered literal in a helper return', () => {
    expect(check('c', "export function helper() { return 'stage.bogus'; }").violations.join()).toMatch(/stage.bogus/);
  });
  test('an unregistered template head', () => {
    expect(check('d', "export const n = (s: 'a') => `provider.${s}`;").violations.join()).toMatch(/unregistered template head "provider\."/);
  });
  test('a suffix widened to string', () => {
    const file = path.relative(repo, path.join(directory, 'e.ts')).split(path.sep).join('/');
    const out = check('e', 'export const n = (s: string) => `execution.${s}`;', [{ file, head: 'execution.' }]);
    expect(out.violations.join()).toMatch(/not a union of string literals/);
  });
  test('an unregistered union member', () => {
    const file = path.relative(repo, path.join(directory, 'f.ts')).split(path.sep).join('/');
    const out = check('f', "export const n = (s: 'completed' | 'zzz') => `execution.${s}`;", [{ file, head: 'execution.' }]);
    expect(out.violations.join()).toMatch(/unregistered event execution.zzz/);
  });
  test('an unregistered json file name', () => {
    expect(check('g', "export const f = 'mystery.json';").violations.join()).toMatch(/unregistered session file "mystery.json"/);
  });
  test('an unregistered literal of the baseline, outputs and revisions families', () => {
    for (const bogus of ['baseline.bogus', 'outputs.bogus', 'revisions.bogus']) {
      expect(check('h', `export const x = '${bogus}';`).violations.join(), bogus).toMatch(new RegExp(`unregistered event literal "${bogus}"`));
    }
  });
  test('an unregistered template head of the baseline, outputs and revisions families', () => {
    for (const head of ['baseline', 'outputs', 'revisions']) {
      expect(check('i', `export const n = (s: 'a') => \`${head}.\${s}\`;`).violations.join(), head).toMatch(new RegExp(`unregistered template head "${head}\\."`));
    }
  });
  test('a registered literal passes', () => {
    expect(check('h', "export const f = 'session.completed'; export const g = 'events.jsonl';").violations).toEqual([]);
  });
});
