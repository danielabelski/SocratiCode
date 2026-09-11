// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * `SOCRATICODE_BRANCH_AWARE=true` is ignored when a project pins an id, and
 * that precedence is deliberate: an explicit id is a stable identity, and
 * suffixing it would rename the collections an existing installation already
 * uses and make its indexes appear missing.
 *
 * What was wrong was the silence. The setting was accepted and did nothing, so
 * the only way to discover it was to read `config.ts`. These tests pin the
 * diagnostic, and — just as importantly — pin that nothing about the resolved
 * ids or the linked-project dedup changed alongside it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above surrounding declarations, so the spy has
// to be created inside vi.hoisted rather than closed over from a plain const.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

const originalEnv = { ...process.env };
let tmp = "";

/** A project directory, optionally pinning an id in `.socraticode.json`. */
function makeProject(name: string, config?: Record<string, unknown>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(dir, ".socraticode.json"), JSON.stringify(config));
  }
  return dir;
}

/** A project on a real, born branch — `rev-parse HEAD` throws until there is a commit. */
function makeGitProject(name: string, branch: string, config?: Record<string, unknown>): string {
  const dir = makeProject(name, config);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("git", ["init", "-b", branch, dir], { stdio: ["pipe", "pipe", "pipe"] });
  git("config", "user.name", "test");
  git("config", "user.email", "test@test.com");
  // A developer's global config commonly has commit.gpgsign=true, which fails
  // in a throwaway repo with no signing key. config.test.ts does the same.
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return dir;
}

beforeEach(() => {
  vi.resetModules();
  warn.mockClear();
  process.env = { ...originalEnv };
  delete process.env.SOCRATICODE_PROJECT_ID;
  delete process.env.SOCRATICODE_BRANCH_AWARE;
  delete process.env.SOCRATICODE_LINKED_PROJECTS;
  delete process.env.QDRANT_COLLECTION_PREFIX;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-branchaware-"));
});

afterEach(() => {
  process.env = { ...originalEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every warning message emitted, for readable assertions. */
function warnings(): string[] {
  return warn.mock.calls.map((c) => String(c[0]));
}

describe("branch-aware ignored because an explicit id won", () => {
  it("warns when the id comes from SOCRATICODE_PROJECT_ID", async () => {
    process.env.SOCRATICODE_PROJECT_ID = "pinned_by_env";
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");

    expect(projectIdFromPath(makeProject("a"))).toBe("pinned_by_env");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/BRANCH_AWARE is ignored/);
    expect(warn.mock.calls[0][1]).toMatchObject({ explicitIdFrom: "SOCRATICODE_PROJECT_ID" });
  });

  it("warns when the id comes from .socraticode.json", async () => {
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");

    expect(projectIdFromPath(makeProject("b", { projectId: "pinned_by_file" }))).toBe(
      "pinned_by_file",
    );
    expect(warnings()).toHaveLength(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ explicitIdFrom: ".socraticode.json projectId" });
  });

  it("says how to actually get per-branch collections, naming the branch", async () => {
    // A diagnostic that only says "ignored" leaves the reader where they
    // started; the whole complaint was that the setting gave no guidance.
    process.env.SOCRATICODE_PROJECT_ID = "pinned";
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");
    projectIdFromPath(makeGitProject("c", "feat/thing"));

    const ctx = warn.mock.calls[0][1] as Record<string, string>;
    expect(ctx.branch).toBe("feat/thing");
    expect(ctx.howToGetPerBranchIndexes).toMatch(/remove the explicit project id/);
    // The suffix it would actually receive, not the raw branch name.
    expect(ctx.howToGetPerBranchIndexes).toContain("feat_thing");
  });

  it("does not advise removing the id when no branch could be detected", async () => {
    // Following that advice in a non-git project would change the project's
    // identity, orphan its collection, and still produce no suffix.
    process.env.SOCRATICODE_PROJECT_ID = "pinned";
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");
    projectIdFromPath(makeProject("c-nogit"));

    const ctx = warn.mock.calls[0][1] as Record<string, string>;
    expect(ctx.branch).toBe("(none detected)");
    expect(ctx.howToGetPerBranchIndexes).toMatch(/no detectable git branch/);
    expect(ctx.howToGetPerBranchIndexes).not.toMatch(/remove the explicit project id/);
  });

it("does not advise removing the id when the branch sanitizes to nothing", async () => {
    // `___` is a legal branch name and sanitizeBranchName strips it to "", so
    // projectIdFromPath returns the unsuffixed id — removing the explicit id
    // would change identity and still produce no per-branch index.
    process.env.SOCRATICODE_PROJECT_ID = "pinned";
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");
    projectIdFromPath(makeGitProject("c-unusable", "___"));

    const ctx = warn.mock.calls[0][1] as Record<string, string>;
    expect(ctx.branch).toBe("___");
    expect(ctx.howToGetPerBranchIndexes).toMatch(/no characters usable/);
    expect(ctx.howToGetPerBranchIndexes).not.toMatch(/remove the explicit project id/);
  });

  it("rejects an invalid explicit id before warning about it", async () => {
    // assertValidProjectId runs first, so an id the process is about to refuse
    // is never entered into the dedupe set nor logged as a live project id.
    process.env.SOCRATICODE_PROJECT_ID = "not a valid id!";
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");

    expect(() => projectIdFromPath(makeProject("c-invalid"))).toThrow();
    expect(warnings()).toHaveLength(0);
  });

  it("warns once per project, not once per call", async () => {
    // projectIdFromPath runs on essentially every tool call, so a warning that
    // repeated would be worse than the silence it replaces.
    process.env.SOCRATICODE_PROJECT_ID = "pinned";
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");
    const project = makeProject("d");

    for (let i = 0; i < 25; i++) projectIdFromPath(project);

    expect(warnings()).toHaveLength(1);
  });

  it("warns for each distinct project, since each is separately affected", async () => {
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");

    projectIdFromPath(makeProject("e", { projectId: "first" }));
    projectIdFromPath(makeProject("f", { projectId: "second" }));
    projectIdFromPath(makeProject("e2", { projectId: "first" })); // same id again

    expect(warnings()).toHaveLength(2);
  });

  it("stays silent when branch-aware mode is off", async () => {
    process.env.SOCRATICODE_PROJECT_ID = "pinned";
    const { projectIdFromPath } = await import("../../src/config.js");
    projectIdFromPath(makeProject("g"));

    expect(warnings()).toHaveLength(0);
  });
});

describe("nothing about resolution changed", () => {
  it("returns the same ids and collection names as before the warning existed", async () => {
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { collectionName, projectIdFromPath } = await import("../../src/config.js");

    const fromFile = makeProject("h", { projectId: "stable_id" });
    expect(projectIdFromPath(fromFile)).toBe("stable_id");
    expect(collectionName(projectIdFromPath(fromFile))).toBe("codebase_stable_id");

    process.env.SOCRATICODE_PROJECT_ID = "env_id";
    expect(projectIdFromPath(fromFile)).toBe("env_id");
    expect(collectionName(projectIdFromPath(fromFile))).toBe("codebase_env_id");
  });

  it("still appends the branch suffix when the id is path-derived", async () => {
    // The feature itself must keep working where it applies, or this change
    // would have quietly turned branch-aware mode off everywhere. A real git
    // repo is required: without one the branch cannot be detected, the suffix
    // is legitimately absent, and this would pass either way.
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const { projectIdFromPath } = await import("../../src/config.js");
    const repo = makeGitProject("i", "feat/my-feature");

    const id = projectIdFromPath(repo);

    expect(warnings()).toHaveLength(0);
    expect(id).toMatch(/^[0-9a-f]{12}__feat_my-feature$/);
  });

  it("leaves linked-project deduplication alone", async () => {
    // resolveLinkedCollections compares an id from projectIdFromPath against
    // ids derived differently for linked projects. The warning must not touch
    // that comparison — it only logs.
    const { resolveLinkedCollections } = await import("../../src/config.js");
    const main = makeProject("j", { projectId: "shared", linkedProjects: ["../j-linked"] });
    makeProject("j-linked", { projectId: "shared" });

    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const collections = resolveLinkedCollections(main);

    // The linked project resolves to the same id, so it is deduped away and
    // only the current project's collection remains.
    expect(collections.map((c) => c.name)).toEqual(["codebase_shared"]);
  });
});
