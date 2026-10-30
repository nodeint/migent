import { expect, test } from "vitest";
import { answerQuestions, parseQuestionBody, type Question } from "../src/questions.ts";

const single: Question = {
  id: "1", question: "Choose scope", context: "Migration adds work.", selection: "single",
  options: [{ id: "A", label: "New only" }, { id: "B", label: "Include existing" }],
};
const multiple: Question = {
  id: "2", question: "Which platforms?", context: "Select the supported platforms.", selection: "multiple",
  options: [{ id: "A", label: "Linux" }, { id: "B", label: "Windows" }, { id: "C", label: "macOS" }],
};

function body(questions: unknown[]) { return "status: question\n\n" + JSON.stringify({ schema_version: 1, questions }); }

test.each([
  { ...single, options: undefined },
  { ...single, selection: undefined },
  { ...single, selection: "any" },
  { ...single, options: [single.options[0]] },
  { ...single, options: [single.options[0], single.options[0]] },
  { ...single, context: "" },
  { ...single, recommended: ["missing"] },
  { ...single, recommended: ["A", "B"] },
])("rejects an incomplete or ambiguous question %j", (question) => {
  expect(() => parseQuestionBody(body([question]))).toThrow("Invalid questions");
});

test("question IDs must be unique in a batch", () => {
  expect(() => parseQuestionBody(body([single, single]))).toThrow("Duplicate question id");
});

test("single and multiple selections have explicit validated answers", () => {
  expect(answerQuestions([single], "A")).toEqual([{ question_id: "1", selected: ["A"] }]);
  expect(answerQuestions([multiple], '["A","B"]')).toEqual([{ question_id: "2", selected: ["A", "B"] }]);
  expect(answerQuestions([single, multiple], '{"1":"B","2":["A","C"]}')).toEqual([
    { question_id: "1", selected: ["B"] }, { question_id: "2", selected: ["A", "C"] },
  ]);
});

test.each([
  [single, '["A","B"]', "exactly one"],
  [multiple, '["A","A"]', "distinct IDs"],
  [multiple, '["unknown"]', "distinct IDs"],
  [multiple, '[]', "distinct IDs"],
  [single, '   ', "distinct IDs"],
] as const)("rejects invalid selection %j %s", (question, reply, error) => {
  expect(() => answerQuestions([question], reply)).toThrow(error);
});

test("free text is always allowed; all questions must be answered", () => {
  expect(answerQuestions([single], "A different scope")).toEqual([
    { question_id: "1", selected: [], text: "A different scope" },
  ]);
  expect(() => answerQuestions([single, multiple], '{"1":"B"}')).toThrow("exactly the pending question IDs");
  expect(() => answerQuestions([single, multiple], "B")).toThrow("Answer every question");
  expect(answerQuestions([single, multiple], '{"1":"A different scope","2":"Decide later"}')).toEqual([
    { question_id: "1", selected: [], text: "A different scope" },
    { question_id: "2", selected: [], text: "Decide later" },
  ]);
});

test.each(["123", "true", "null"])("plain reply %s remains free text", (reply) => {
  expect(answerQuestions([single], reply)).toEqual([{ question_id: "1", selected: [], text: reply }]);
});

test("Migent assigns question numbers and option letters when the agent omits IDs", () => {
  const { id: firstId, ...first } = single;
  const { id: secondId, ...second } = multiple;
  const withoutIds = (question: typeof first) => ({ ...question, options: question.options.map(({ id, ...option }) => option) });
  const parsed = parseQuestionBody(body([withoutIds(first), withoutIds(second)]));
  expect(parsed.map((question) => question.id)).toEqual(["1", "2"]);
  expect(parsed[1]!.options.map((option) => option.id)).toEqual(["A", "B", "C"]);
});

test("numbered replies mix choices, multiple choices, and free text", () => {
  const questions = [single, multiple, { ...single, id: "3" }];
  expect(answerQuestions(questions, "1A, 2B, 3 chưa rõ - giải thích thêm")).toEqual([
    { question_id: "1", selected: ["A"] },
    { question_id: "2", selected: ["B"] },
    { question_id: "3", selected: [], text: "chưa rõ - giải thích thêm" },
  ]);
  expect(answerQuestions(questions, "1a\n2a+c\n3 chưa rõ, giải thích thêm")).toEqual([
    { question_id: "1", selected: ["A"] },
    { question_id: "2", selected: ["A", "C"] },
    { question_id: "3", selected: [], text: "chưa rõ, giải thích thêm" },
  ]);
  expect(answerQuestions([multiple], "A+C")).toEqual([{ question_id: "2", selected: ["A", "C"] }]);
});

test("numbered replies reject unknown numbers, duplicate entries and invalid selections", () => {
  expect(() => answerQuestions([single, multiple], "1A, 3B")).toThrow("Unknown question number: 3");
  expect(() => answerQuestions([single, multiple], "1A, 1B, 2A")).toThrow("answered more than once");
  expect(() => answerQuestions([single], "1A+B")).toThrow("exactly one");
  expect(() => answerQuestions([single], "1Z")).toThrow("distinct IDs");
  expect(() => answerQuestions([multiple], "2A+A")).toThrow("distinct IDs");
});
