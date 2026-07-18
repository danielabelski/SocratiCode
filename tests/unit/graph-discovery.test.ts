// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCodeGraph, ensureDynamicLanguages, getGraphableFiles } from "../../src/services/code-graph.js";

// Regression for the whitelist .gitignore discovery fix: a `/*` then `!/src/`
// pattern ignores everything at the root but re-includes `src/`. The old walk
// passed `src` (no trailing slash) to shouldIgnore, which `/*` matched, so the
// walk bailed and produced an empty graph. Passing `src/` lets it descend and
// the files under the re-included directory are actually picked up.
describe("getGraphableFiles — whitelist .gitignore", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "/*\n!/src/\n");
    fs.writeFileSync(
      path.join(root, "src", "mod.lua"),
      "local function f()\n  return 1\nend\nreturn f\n",
    );
    // A root-level file the `/*` pattern should keep ignored.
    fs.writeFileSync(path.join(root, "ignored.lua"), "return 1\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("descends into re-included src/ and discovers its files", async () => {
    const files = await getGraphableFiles(root);
    expect(files).toContain("src/mod.lua");
    // The `/*` pattern still ignores top-level entries that are not re-included.
    expect(files).not.toContain("ignored.lua");
  });
});

describe("getGraphableFiles / buildCodeGraph — extensionless", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-graph-extless-"));
    // No-shebang Python (waf wscript) — grammar-bearing → graph-eligible.
    fs.writeFileSync(
      path.join(root, "wscript"),
      "def configure(conf):\n    return 1\n\ndef build(bld):\n    return configure(bld)\n",
    );
    // perl shebang → detected as .txt → grammar-less → NOT in graph.
    fs.writeFileSync(path.join(root, "helper"), "#!/usr/bin/perl\nprint 1;\n");
    // Non-code extensionless → not in graph.
    fs.writeFileSync(path.join(root, "NOTICE"), "All rights reserved.\n");
    // SPECIAL_FILE with a shell recipe: must NOT be content-detected into the
    // graph as a shell node (handled by name elsewhere).
    fs.writeFileSync(
      path.join(root, "Makefile"),
      "build:\n\tset -euo pipefail\n\tif [ -f foo ]; then \\\n\t\techo yes; \\\n\tfi\n",
    );
    // Extensionless dotfile with shell content: sniffs to .sh, but the index
    // (glob dot:false) never sees it, so the graph must skip it too.
    fs.writeFileSync(
      path.join(root, ".profile"),
      'set -eu\nif [ -d "$HOME/bin" ]; then\n  export PATH="$HOME/bin"\nfi\n',
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("includes grammar-bearing extensionless files, excludes .txt-detected and non-code", async () => {
    const files = await getGraphableFiles(root);
    expect(files).toContain("wscript");
    expect(files).not.toContain("helper"); // .txt — grammar-less, stays out of graph
    expect(files).not.toContain("NOTICE");
    expect(files).not.toContain("Makefile"); // SPECIAL_FILE — never content-detected
    expect(files).not.toContain(".profile"); // extensionless dotfile — matches index dot:false policy
  });

  it("excludes all extensionless files when INDEX_EXTENSIONLESS=false", async () => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "false");
    try {
      const files = await getGraphableFiles(root);
      expect(files).not.toContain("wscript");
      expect(files).not.toContain("helper");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("includes a detected extensionless dotfile when INCLUDE_DOT_FILES=true", async () => {
    vi.stubEnv("INCLUDE_DOT_FILES", "true");
    try {
      const files = await getGraphableFiles(root);
      expect(files).toContain(".profile"); // shell dotfile now admitted (matches the index)
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("extracts symbols for a detected extensionless Python file", async () => {
    const graph = await buildCodeGraph(root);
    const symbols = graph.symbolsByFile.get("wscript");
    expect(symbols).toBeDefined();
    expect((symbols ?? []).map((s) => s.name)).toEqual(expect.arrayContaining(["configure", "build"]));
  });
});
