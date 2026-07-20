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

// ── Go module resolution through the real pipeline (#45 root + #82 nested) ─
// These drive the actual getGraphableFiles → buildCodeGraph path, where
// go.mod is NOT part of the graphable file set (it has no AST grammar).
// The first #82 attempt scanned the file set for go.mod and so produced 0
// edges for EVERY Go project — root or nested — while its hand-built unit
// tests stayed green. These end-to-end checks fail under that approach.
function writeLayout(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("buildCodeGraph — Go module resolution (issues #45 & #82)", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Confirms getGraphableFiles admits the .go files (it does) and that
  // buildCodeGraph then builds Go edges — independent of any unit test's
  // hand-built file set.
  async function buildGraph(layout: Record<string, string>): Promise<ReturnType<typeof buildCodeGraph>> {
    const dir = writeLayout(layout);
    roots.push(dir);
    return buildCodeGraph(dir);
  }

  it("produces Go edges when go.mod is at the indexed root (#45 still works)", async () => {
    const graph = await buildGraph({
      "go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
      "main.go": [
        "package main",
        "",
        "import \"github.com/example/myapp/internal/middleware\"",
        "",
        "func main() {",
        "\tif middleware.Authorize(\"admin\") {}",
        "}",
      ].join("\n"),
      "internal/middleware/auth.go": [
        "package middleware",
        "",
        "func Authorize(role string) bool { return role == \"admin\" }",
      ].join("\n"),
    });

    // The root-level module path resolves the import to a real file and an
    // edge is created. This is the #45 behavior that must not regress.
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("produces Go edges when go.mod is nested below the indexed root (#82)", async () => {
    // The exact monorepo shape from the issue: go.mod lives in `backend/`,
    // one level below the path passed to buildCodeGraph.
    const graph = await buildGraph({
      "docker-compose.yml": "services: {}\n",
      "frontend/src/app.ts": "export const x = 1;\n",
      "backend/go.mod": "module github.com/example/myapp-backend\n\ngo 1.22\n",
      "backend/internal/middleware/auth.go": [
        "package middleware",
        "",
        "func Authorize(role string) bool { return role == \"admin\" }",
      ].join("\n"),
      "backend/internal/service/user.go": [
        "package service",
        "",
        "import \"github.com/example/myapp-backend/internal/middleware\"",
        "",
        "func CanDeleteUser(role string) bool {",
        "\treturn middleware.Authorize(role)",
        "}",
      ].join("\n"),
      "backend/cmd/server/main.go": [
        "package main",
        "",
        "import (",
        "\t\"github.com/example/myapp-backend/internal/middleware\"",
        "\t\"github.com/example/myapp-backend/internal/service\"",
        ")",
        "",
        "func main() {",
        "\tif middleware.Authorize(\"admin\") {",
        "\t\t_ = service.CanDeleteUser(\"admin\")",
        "\t}",
        "}",
      ].join("\n"),
    });

    // Non-Go files are unaffected and still produce edges.
    expect(graph.edges.some((e) => e.source === "frontend/src/app.ts")).toBe(false);

    // The nested module is discovered from disk (go.mod is not graphable)
    // and both cross-package imports resolve to real edges.
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "backend/cmd/server/main.go" &&
          e.target === "backend/internal/middleware/auth.go",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "backend/internal/service/user.go" &&
          e.target === "backend/internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("resolves a nested module under a single-character dir `z/` (depth tie-break)", async () => {
    // Root module `github.com/example/root` + nested `github.com/example/z`
    // under `z/`. A string-length tie-break (`.` and `z` are both length 1)
    // can mis-attribute `z/` files to the root; directory depth must not.
    const graph = await buildGraph({
      "go.mod": "module github.com/example/root\n\ngo 1.22\n",
      "main.go": "package main\n\nfunc main() {}\n",
      "z/go.mod": "module github.com/example/z\n\ngo 1.22\n",
      "z/svc/bar.go": "package svc\n\nfunc Bar() {}\n",
      "z/caller/main.go": [
        "package main",
        "",
        "import \"github.com/example/z/svc\"",
        "",
        "func main() { _ = svc.Bar() }",
      ].join("\n"),
    });

    // The `z/` module owns its files (depth 1 > root depth 0), so the
    // import `github.com/example/z/svc` resolves to z/svc/bar.go and an edge
    // is created. Under the buggy string-length tie-break this would either
    // fail to resolve or attribute the edge to the root module.
    expect(
      graph.edges.some(
        (e) => e.source === "z/caller/main.go" && e.target === "z/svc/bar.go",
      ),
    ).toBe(true);
  });

  it("discovers a symlinked go.mod (no symlink regression vs the old single read)", async () => {
    // readdirSync Dirents don't follow symlinks: a symlinked go.mod reports
    // isFile()===false. The old root-level readFileSync DID follow it, so the
    // new tree walk must too — otherwise a root-level symlinked go.mod
    // regresses to 0 edges (PR #84 review).
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-symlink-src-"));
    roots.push(target);
    const realGoMod = path.join(target, "go.mod.real");
    fs.writeFileSync(realGoMod, "module github.com/example/symlinked\n\ngo 1.22\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-e2e-"));
    roots.push(dir);
    // go.mod is a symlink to a file OUTSIDE the indexed tree.
    fs.symlinkSync(realGoMod, path.join(dir, "go.mod"));
    fs.writeFileSync(
      path.join(dir, "main.go"),
      [
        "package main",
        "",
        'import "github.com/example/symlinked/internal/middleware"',
        "",
        'func main() { _ = middleware.Authorize("admin") }',
      ].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "internal", "middleware"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "internal", "middleware", "auth.go"),
      [
        "package middleware",
        "",
        'func Authorize(role string) bool { return role == "admin" }',
      ].join("\n"),
    );

    const graph = await buildCodeGraph(dir);
    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("ignores a stray go.mod under a default-ignored dir (build/) so it can't shadow the real module", async () => {
    // findGoModFiles reuses createIgnoreFilter; `build/` is in the default
    // skip list (and hard-skipped in findNestedGitignores). If discovery ever
    // bypassed the filter, the stray build/go.mod — declaring the SAME module
    // path as the root and alphabetically first — would win module selection
    // in resolveImport with an empty package map and silently drop every edge:
    // the same silent-zero-edge class #82 fixes. This case fails the moment
    // shouldIgnore is stubbed to a no-op.
    const graph = await buildGraph({
      "go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
      "main.go": [
        "package main",
        "",
        'import "github.com/example/myapp/internal/middleware"',
        "",
        'func main() { _ = middleware.Authorize("admin") }',
      ].join("\n"),
      "internal/middleware/auth.go": [
        "package middleware",
        "",
        'func Authorize(role string) bool { return role == "admin" }',
      ].join("\n"),
      // Stray module under an ignored dir: same module path as the root, so it
      // would shadow the root module if discovery ever picked it up.
      "build/go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
    });

    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });
});
