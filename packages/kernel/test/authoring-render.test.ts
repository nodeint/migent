import { expect, test } from "vitest";
import { renderAuthoringYaml } from "../src/index.ts";

const data = {
  schema_version: 4,
  id: "build",
  stages: [{ id: "a", role: "developer", depends_on: [] }],
};

test("unchanged data returns the base bytes verbatim", () => {
  const base = "# mine\r\nschema_version: 4\r\nid: build\r\nstages:\r\n    -   id: a\r\n        role: developer\r\n        depends_on: [ ]";
  const result = renderAuthoringYaml(data, base);
  expect(result).toEqual({ text: base, preserved: true });
});

test("without a base the rendering is canonical", () => {
  const result = renderAuthoringYaml(data);
  expect(result.preserved).toBe(true);
  expect(result.text).toBe("schema_version: 4\nid: build\nstages:\n  - id: a\n    role: developer\n    depends_on: []\n");
});

test("a field edit keeps comments, key order and line endings", () => {
  const base = "# top\r\nschema_version: 4\r\n# stage\r\nstages:\r\n  - id: a\r\n    role: developer\r\n    depends_on: []\r\nid: build\r\n";
  const edited = { ...data, stages: [{ id: "a", role: "developer", depends_on: [], description: "added" }] };
  const result = renderAuthoringYaml(edited, base);
  expect(result.preserved).toBe(true);
  expect(result.text).toContain("# top");
  expect(result.text).toContain("# stage");
  expect(result.text).toContain("\r\n");
  expect(result.text.indexOf("stages:")).toBeLessThan(result.text.indexOf("id: build"));
  expect(result.text).toContain("    description: added\r\n");
});

test("stages are matched by id, so a reorder keeps their comments", () => {
  const base = "schema_version: 4\nid: build\nstages:\n  - id: a # first\n    role: developer\n  - id: b # second\n    role: developer\n";
  const reordered = {
    schema_version: 4,
    id: "build",
    stages: [
      { id: "b", role: "developer" },
      { id: "a", role: "developer" },
    ],
  };
  const result = renderAuthoringYaml(reordered, base);
  expect(result.preserved).toBe(true);
  expect(result.text.indexOf("# second")).toBeLessThan(result.text.indexOf("# first"));
});

test("a key absent from the draft is removed", () => {
  const base = "schema_version: 4\nid: build\ndescription: gone\n";
  const result = renderAuthoringYaml({ schema_version: 4, id: "build" }, base);
  expect(result.preserved).toBe(true);
  expect(result.text).not.toContain("description");
});

test("an anchor falls back to canonical bytes with a reason", () => {
  const base = "schema_version: 4\nid: &id build\n";
  const result = renderAuthoringYaml({ schema_version: 4, id: "build", description: "new" }, base);
  expect(result.preserved).toBe(false);
  expect(result.reason).toBe("the base uses an anchor");
  expect(result.text).toBe("schema_version: 4\nid: build\ndescription: new\n");
});

test("a base that does not parse falls back with a reason", () => {
  const result = renderAuthoringYaml({ id: "build" }, "a: [\n");
  expect(result.preserved).toBe(false);
  expect(result.reason).toBe("the base is not valid YAML");
  expect(result.text).toBe("id: build\n");
});
