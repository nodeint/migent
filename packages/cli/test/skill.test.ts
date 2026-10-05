import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { installSkill, updateSkill } from "../src/commands/skill.ts";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

function workspaceOf(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const config = path.join(workspace, ".migent", "config.yaml");
  mkdirSync(path.dirname(config));
  writeFileSync(config, "models: {}\nroles: {}\n", "utf8");
  return workspace;
}

test("install writes a managed skill", () => {
  const workspace = workspaceOf();
  try {
    expect(installSkill(workspace)).toBe(0);
    const skillDirectory = path.join(workspace, ".agents", "skills", "migent");
    const content = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
    const state = JSON.parse(readFileSync(path.join(skillDirectory, ".migent-template.json"), "utf8")) as {
      template_version: number;
      content_sha256: string;
    };
    expect(content).toContain("name: migent");
    expect(state.template_version).toBe(1);
    expect(state.content_sha256).toHaveLength(64);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("install refuses to replace an existing directory", () => {
  const workspace = workspaceOf();
  try {
    const skillDirectory = path.join(workspace, ".agents", "skills", "migent");
    mkdirSync(skillDirectory, { recursive: true });
    const custom = path.join(skillDirectory, "SKILL.md");
    writeFileSync(custom, "custom\n", "utf8");
    expect(installSkill(workspace)).toBe(1);
    expect(readFileSync(custom, "utf8")).toBe("custom\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("update refuses local changes unless forced", () => {
  const workspace = workspaceOf();
  try {
    expect(installSkill(workspace)).toBe(0);
    const skill = path.join(workspace, ".agents", "skills", "migent", "SKILL.md");
    writeFileSync(skill, "custom\n", "utf8");
    expect(updateSkill(workspace)).toBe(1);
    expect(readFileSync(skill, "utf8")).toBe("custom\n");
    expect(updateSkill(workspace, { force: true })).toBe(0);
    expect(readFileSync(skill, "utf8")).toContain("name: migent");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("update replaces an older managed template", () => {
  const workspace = workspaceOf();
  try {
    expect(installSkill(workspace)).toBe(0);
    const skillDirectory = path.join(workspace, ".agents", "skills", "migent");
    const skill = path.join(skillDirectory, "SKILL.md");
    const oldContent = "---\nname: migent\ndescription: Old template.\n---\n";
    writeFileSync(skill, oldContent, "utf8");
    writeFileSync(
      path.join(skillDirectory, ".migent-template.json"),
      JSON.stringify({
        schema_version: 1,
        template_version: 0,
        content_sha256: createHash("sha256").update(oldContent, "utf8").digest("hex"),
      }),
      "utf8",
    );
    expect(updateSkill(workspace)).toBe(0);
    const updated = readFileSync(skill, "utf8");
    expect(updated).toContain("name: migent");
    expect(updated).not.toContain("Old template");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("update refuses an unmanaged skill", () => {
  const workspace = workspaceOf();
  try {
    const skill = path.join(workspace, ".agents", "skills", "migent", "SKILL.md");
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, "custom\n", "utf8");
    expect(updateSkill(workspace, { force: true })).toBe(1);
    expect(readFileSync(skill, "utf8")).toBe("custom\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cli exposes install and update", async () => {
  const workspace = workspaceOf();
  try {
    const captured = await capture(async () => {
      expect(await main(["skill", "install"], workspace)).toBe(0);
      expect(await main(["skill", "update"], workspace)).toBe(0);
    });
    expect(captured.stdout).toContain("Installed");
    expect(captured.stdout).toContain("Already up to date");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
