import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { renderPrompt } from "../src/renderer.ts";
import {
  addArtifactContext, buildStageReplyPrompt, flattenHistory, formatQuestionAnswers, renderProtocolUpdate,
  renderProviderPrompt, renderStageStart, renderVerifyRepair, type TurnKind,
} from "../src/index.ts";

// Contract inputs, including literal text that must not be escaped or evaluated.
const contracts = JSON.parse(readFileSync(new URL("./fixtures/prompt-contracts.json", import.meta.url), "utf8"));
for (const example of contracts) {
  test(`renders the full contract (ask=${example.ask}, decisions=${example.values.length})`, () => {
    expect(renderProviderPrompt(example.body, {
      contract: true, ask: example.ask, decisionValues: example.values,
      decisionInstructions: example.instructions, artifactDirectory: example.directory,
      artifactName: example.artifact, questionFile: example.questionFile,
    })).toMatchSnapshot();
  });
}

test("orders the stage prompt stable first: contract, stage, execution, ask", () => {
  const body = renderStageStart({
    taskFile: "/s/task.md", sessionDirectory: "/s",
    stage: { id: "plan", role: "planner", instructions: ["Stay at the architecture level.", "Be brief."], verify: [] },
    roleInstructions: ["Be brief."], constraints: ["Plan only."], upstream: [], routed: null, blocked: null, prior: null,
  });
  const prompt = renderProviderPrompt(body, {
    contract: true, turn: "start", ask: "human", taskFile: "/s/task.md", sessionDirectory: "/s", questionFile: "/s/e1/question-request.json", artifactDirectory: "/s/e1/artifacts", artifactName: "plan.md",
  });
  const order = ["# Migent workflow stage", "## Response contract", "## Asking questions", "## Stage: plan (role: planner)",
    "### Role", "### Instructions", "### Constraints", "## Execution", "## Do"].map((heading) => prompt.indexOf(`${heading}\n`));
  expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
  expect(prompt.match(/- Be brief\./g)).toHaveLength(1);
  expect(prompt).toContain("## Execution\n\n- Task: `/s/task.md`\n- Session dir: `/s` (shared session files)");
  expect(prompt).toContain("## Do\n\nRead the task, then carry out the stage.\nWrite the artifact as `plan.md`");
  expect(prompt).not.toContain("route");
  expect(prompt).toMatchSnapshot();
});

test("a reminder turn restates the status line and paths without the contract", () => {
  const prompt = renderProviderPrompt("## Human answers", {
    contract: "reminder", turn: "answers", ask: "human", questionFile: "/q.json", artifactDirectory: "/e2/artifacts",
    artifactName: "plan.md", previousArtifactDirectory: "/e1/artifacts",
  });
  expect(prompt).not.toContain("## Response contract");
  expect(prompt).toBe([
    "## Human answers", "", "## Execution", "", "- Question file: `/q.json`", "- Artifacts: `/e2/artifacts`",
    "- Previous artifacts: `/e1/artifacts` (continue from these if present)", "", "## Do", "",
    "Continue the stage using these answers.",
    "Write the artifact as `plan.md` in the artifacts directory.",
    "Same response contract and stage instructions as before: start with `status: complete | question | blocked`.",
  ].join("\n"));
});

test("answers always show the selection, option IDs, and free text separately", () => {
  const questions = [
    { id: "1", question: "Which season?", selection: "single" as const, options: [{ id: "A", label: "Spring" }, { id: "B", label: "Winter" }] },
    { id: "2", question: "Which drinks?", selection: "multiple" as const, options: [{ id: "A", label: "Tea" }, { id: "B", label: "Coffee" }] },
  ];
  expect(formatQuestionAnswers(questions, [
    { question_id: "1", selected: ["B"] }, { question_id: "2", selected: [], text: "wine" },
  ])).toBe([
    "1. Which season? (single)", "   - Selected: B. Winter", "",
    "2. Which drinks? (multiple)", "   - Selected: none", '   - Free text: "wine"',
  ].join("\n"));
});

test("renders context as literal data without escaping HTML or evaluating nested templates", () => {
  const content = '<tag> & `code` {{unknown}}\r\n  preserve spaces\n';
  expect(buildStageReplyPrompt(content, { interrupted: true })).toBe(
    `## Human reply\n\nYour previous turn was stopped by the human before it finished. Their message:\n\n${content}`,
  );
  expect(buildStageReplyPrompt(content, { answers: true })).toBe(
    `## Human answers\n\nAnswers to your latest questions.\n\n${content}`,
  );
  expect(flattenHistory([{ role: 'user', content }, { role: 'assistant', content: 'ok' }]))
    .toBe(`user: ${content}\n\nassistant: ok`);
  expect(renderProviderPrompt(content)).toBe(content);
  expect(addArtifactContext(content, 'unused')).toBe(content);
});

test("repair and previous verify report layout", () => {
  expect(renderVerifyRepair({ report: 'check <failed>\n', red: 1, maxVerify: 3, artifactPath: 'C:\\work\\result.md', taskFile: null, sessionDirectory: null })).toBe(
    '## Verify failed\n\n1 of 3 red runs.\n\n- Stage artifact: `C:\\work\\result.md` (update it if your fix changes it)\n\n### Report\n\ncheck <failed>\n',
  );
  expect(renderProviderPrompt('body', { previousVerifyReport: 'C:\\work\\verify.md' }))
    .toBe('body\n\n## Execution\n\n- Previous verify report: `C:\\work\\verify.md`');
});

test("a protocol update follows the old prompt and carries the full contract", () => {
  const update = renderProtocolUpdate({ ask: "human", questionFile: "/q.json" });
  expect(update.startsWith("\n\n---\n\n# Response protocol update\n")).toBe(true);
  expect(update).toContain("## Asking questions");
  expect(update).toContain("- Question file: `/q.json`");
});

test("the closing instruction follows the turn kind", () => {
  const close = (turn: TurnKind, taskFile: string | null = "/s/task.md") =>
    renderProviderPrompt("body", { contract: true, turn, taskFile, sessionDirectory: "/s" }).split("## Do\n\n")[1]!.split("\n")[0];
  expect(close("start")).toBe("Read the task, then carry out the stage.");
  expect(close("start", null)).toBe("Carry out the stage.");
  expect(close("continue")).toBe("Read the task, then continue the stage with the context above.");
  expect(close("reply")).toBe("Continue the stage with the human reply above.");
  expect(close("answers")).toBe("Continue the stage using these answers.");
  expect(close("repair")).toBe("Fix the verify failure above, then report again.");
  expect(close("correction")).toBe("Rewrite the whole question file as one valid JSON document, then respond again.");
  expect(renderProviderPrompt("body", { contract: true })).toContain("## Do\n\nCarry out the request above.");
});

test("missing template data fails rather than silently omitting content", () => {
  expect(() => renderPrompt('stage-reply', {})).toThrow();
});
