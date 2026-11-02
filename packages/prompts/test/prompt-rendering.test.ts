import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { renderPrompt } from "../src/renderer.ts";
import { addArtifactContext, buildStageReplyPrompt, flattenHistory, renderProviderPrompt, renderVerifyRepair } from "../src/index.ts";

// Captured from the pre-template renderer, including whitespace and protocol examples.
const contracts = JSON.parse(readFileSync(new URL("./fixtures/prompt-contracts.json", import.meta.url), "utf8"));
for (const example of contracts) {
  test(`preserves contract bytes (ask=${example.ask}, decisions=${example.values.length})`, () => {
    expect(renderProviderPrompt(example.body, {
      contract: true, ask: example.ask, decisionValues: example.values,
      decisionInstructions: example.instructions, artifactDirectory: example.directory,
      artifactName: example.artifact,
    })).toBe(example.output);
  });
}

test("renders context as literal data without escaping HTML or evaluating nested templates", () => {
  const content = '<tag> & `code` {{unknown}}\r\n  preserve spaces\n';
  expect(buildStageReplyPrompt(content, 'Question <A>?', 'exec-1')).toBe(
    `Your previous turn (execution exec-1) was stopped by the human before it finished.\n\nReply to: Question <A>?\n${content}`,
  );
  expect(flattenHistory([{ role: 'user', content }, { role: 'assistant', content: 'ok' }]))
    .toBe(`user: ${content}\n\nassistant: ok`);
  expect(renderProviderPrompt(content)).toBe(content);
  expect(addArtifactContext(content, 'unused')).toBe(content);
});

test("repair and previous verify report preserve their original layout", () => {
  expect(renderVerifyRepair({ report: 'check <failed>\n', red: 1, maxVerify: 3, artifactPath: 'C:\\work\\result.md', taskFile: null, sessionDirectory: null })).toBe(
    'Verify failed (1 of 3 red runs). Fix the cause, then report again.\nThe stage artifact is at C:\\work\\result.md. Update it if your fix changes it.\n\ncheck <failed>\n',
  );
  expect(renderProviderPrompt('body', { previousVerifyReport: 'C:\\work\\verify.md' }))
    .toBe('body\n\nPrevious verify report: C:\\work\\verify.md');
});

test("missing template data fails rather than silently omitting content", () => {
  expect(() => renderPrompt('stage-reply', {})).toThrow();
});
