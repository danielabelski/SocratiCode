// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectIdFromPath } from "../../src/config.js";
import {
  invalidateGraphCache,
  rebuildGraph,
} from "../../src/services/code-graph.js";
import { updateChangedFilesSymbolGraph } from "../../src/services/symbol-graph-incremental.js";
import {
  loadFilePayload,
  loadSymbolGraphMeta,
} from "../../src/services/symbol-graph-store.js";
import {
  createFixtureProject,
  type FixtureProject,
  isDockerAvailable,
} from "../helpers/fixtures.js";
import { waitForQdrant } from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "symbol-graph-incremental",
  { timeout: 120_000 },
  () => {
    let fixture: FixtureProject;
    let projectId: string;

    beforeAll(async () => {
      await waitForQdrant();
      fixture = createFixtureProject("symbol-graph-incremental-test");
      projectId = projectIdFromPath(fixture.root);
      // Establish baseline meta + payloads from a real full rebuild.
      await rebuildGraph(fixture.root);
    }, 60_000);

    afterAll(() => {
      invalidateGraphCache(fixture.root);
      fixture.cleanup();
    });

    it("returns fullRebuildRequired=false when meta exists (no-op call)", async () => {
      const graph = await rebuildGraph(fixture.root);
      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [],
      );
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.filesChanged).toBe(0);
      expect(result.filesRemoved).toBe(0);
    });

    it("re-extracts and persists a changed file's payload", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/index.ts";

      // Mutate the file: add a new exported function.
      const abs = path.join(fixture.root, rel);
      const original = fs.readFileSync(abs, "utf-8");
      try {
        fs.writeFileSync(
          abs,
          `${original}\nexport function brandNewIncrementalSymbol(): number { return 42; }\n`,
          "utf-8",
        );

        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(false);
        expect(result.filesChanged).toBe(1);

        // The new symbol should appear in the persisted payload.
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).toBeTruthy();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        expect(names).toContain("brandNewIncrementalSymbol");
      } finally {
        fs.writeFileSync(abs, original, "utf-8");
      }
    });

    it("is a no-op when content hash is unchanged", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/index.ts";
      const before = await loadSymbolGraphMeta(projectId);
      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [rel],
        [],
      );
      // The diff path detects identical hash and skips writes.
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.symbolsDelta).toBe(0);
      expect(result.edgesDelta).toBe(0);
      const after = await loadSymbolGraphMeta(projectId);
      expect(after?.symbolCount).toBe(before?.symbolCount);
    });

    it("removes a deleted file's payload from the store", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/utils/helpers.ts";
      // Confirm baseline.
      const before = await loadFilePayload(projectId, rel);
      expect(before).toBeTruthy();

      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [rel],
      );
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.filesRemoved).toBe(1);

      const after = await loadFilePayload(projectId, rel);
      expect(after).toBeNull();
    });

    it("handles symbols whose names collide with Object.prototype keys (regression)", async () => {
      // Regression for the "existing.push is not a function" crash hit on
      // SocratiCode itself: symbols named `constructor` / `toString` /
      // `hasOwnProperty` previously short-circuited bracket lookup on a
      // plain `{}` shard to the prototype value (a function), then
      // `existing.push(...)` blew up.
      const rel = "src/proto-keys.ts";
      const filePath = path.join(fixture.root, rel);
      fs.writeFileSync(
        filePath,
        [
          "export class A {",
          "  constructor() {}",
          "  toString() { return \"a\"; }",
          "  hasOwnProperty() { return true; }",
          "}",
          "",
          "export function constructor() { return 1; }",
          "export function toString() { return \"x\"; }",
          "export function hasOwnProperty() { return false; }",
          "",
        ].join("\n"),
        "utf-8",
      );
      try {
        // The original crash happened during the *full* persistSymbolGraph
        // path, so exercise that as well.
        await rebuildGraph(fixture.root);
        const meta = await loadSymbolGraphMeta(projectId);
        expect(meta).not.toBeNull();
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).not.toBeNull();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        // All three prototype-collision names must be present.
        expect(names).toEqual(expect.arrayContaining(["constructor", "toString", "hasOwnProperty"]));

        // And the incremental path must also accept them without throwing.
        // Mutate the file so the incremental layer doesn't skip it as
        // unchanged (its hash already matches after the full rebuild above).
        fs.appendFileSync(filePath, "\nexport const PROTO_KEYS_REV = 2;\n", "utf-8");
        const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });
        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(false);
        expect(result.filesChanged).toBe(1);
      } finally {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    });

    it("patches a detected extensionless Python file on the incremental path", async () => {
      // A no-shebang Python file with NO extension. The `extra()` symbol is
      // appended AFTER the full rebuild, so it can only reach the store via the
      // incremental path, which skips any file whose getAstGrepLang(ext) is null
      // unless the extension is re-detected first. Proves the gate re-detects it.
      const rel = "deploy/gen-config";
      const abs = path.join(fixture.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(
        abs,
        "def render_config():\n    return build_section()\n\ndef build_section():\n    return 1\n",
        "utf-8",
      );
      try {
        const graph = await rebuildGraph(fixture.root);
        fs.appendFileSync(abs, "\ndef extra():\n    return render_config()\n", "utf-8");

        const result = await updateChangedFilesSymbolGraph(projectId, fixture.root, graph, [rel], []);
        expect(result.fullRebuildRequired).toBe(false);
        expect(result.filesChanged).toBe(1);

        const payload = await loadFilePayload(projectId, rel);
        expect(payload).toBeTruthy();
        expect(payload?.language).toBe("python");
        const names = payload?.symbols.map((s) => s.name) ?? [];
        expect(names).toEqual(expect.arrayContaining(["render_config", "build_section", "extra"]));
      } finally {
        try {
          fs.rmSync(path.join(fixture.root, "deploy"), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("full rebuild persists a detected extensionless Python file; .txt-detected is excluded", async () => {
      // Both graph paths: the incremental path is covered above; this covers
      // the full rebuildGraph() path. A no-shebang Python file (grammar-bearing)
      // is persisted with its symbols; a perl-shebang file (detected .txt) is
      // grammar-less and must not enter the symbol graph.
      const pyRel = "tools/gen";
      const txtRel = "tools/legacy";
      fs.mkdirSync(path.join(fixture.root, "tools"), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.root, pyRel),
        "def make_manifest():\n    return 1\n\nclass Builder:\n    def run(self):\n        return make_manifest()\n",
        "utf-8",
      );
      fs.writeFileSync(path.join(fixture.root, txtRel), "#!/usr/bin/perl\nprint \"legacy\\n\";\n", "utf-8");
      try {
        await rebuildGraph(fixture.root);

        const pyPayload = await loadFilePayload(projectId, pyRel);
        expect(pyPayload).toBeTruthy();
        expect(pyPayload?.language).toBe("python");
        const names = pyPayload?.symbols.map((s) => s.name) ?? [];
        expect(names).toEqual(expect.arrayContaining(["make_manifest", "Builder"]));

        // .txt-detected file contributes no symbol payload (not in the graph).
        const txtPayload = await loadFilePayload(projectId, txtRel);
        expect(txtPayload).toBeNull();
      } finally {
        try {
          fs.rmSync(path.join(fixture.root, "tools"), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("skips extensionless files on the incremental path when INDEX_EXTENSIONLESS=false", async () => {
      const rel = "offswitch/gen";
      const abs = path.join(fixture.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "def off_marker():\n    return 1\n", "utf-8");
      // Build the file-import graph with detection ON (so the file is present),
      // then disable and run the incremental patch — it must skip the file.
      const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });
      const prev = process.env.INDEX_EXTENSIONLESS;
      process.env.INDEX_EXTENSIONLESS = "false";
      try {
        const result = await updateChangedFilesSymbolGraph(projectId, fixture.root, graph, [rel], []);
        expect(result.fullRebuildRequired).toBe(false);
        expect(result.filesChanged).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.INDEX_EXTENSIONLESS;
        else process.env.INDEX_EXTENSIONLESS = prev;
        try {
          fs.rmSync(path.join(fixture.root, "offswitch"), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("purges stale symbols when a changed extensionless file loses its grammar (grammar → .txt)", async () => {
      const rel = "svc/gen";
      const abs = path.join(fixture.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // No-shebang Python → detected .py → symbols + an intra-file call edge
      // (render_thing → helper) extracted and persisted, so the purge must
      // decrement both the symbol and the edge counters.
      fs.writeFileSync(abs, "def render_thing():\n    return helper()\n\ndef helper():\n    return 1\n", "utf-8");
      try {
        await rebuildGraph(fixture.root);
        const before = await loadFilePayload(projectId, rel);
        expect(before).toBeTruthy();
        expect((before?.symbols ?? []).map((s) => s.name)).toContain("render_thing");

        // Content now detects as .txt (unmapped perl shebang). It stays indexable,
        // so it arrives as a *changed* (not removed) file — but its stale python
        // symbols must be dropped to match a full rebuild (which excludes .txt).
        fs.writeFileSync(abs, '#!/usr/bin/perl\nprint "no longer python\\n";\n', "utf-8");
        const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });
        const result = await updateChangedFilesSymbolGraph(projectId, fixture.root, graph, [rel], []);
        expect(result.fullRebuildRequired).toBe(false);
        // Pin the removal bookkeeping (feeds persisted meta counts), not just the
        // payload delete — else dropping the counter lines would go uncaught.
        expect(result.filesRemoved).toBe(1);
        expect(result.symbolsDelta).toBeLessThan(0);
        expect(result.edgesDelta).toBeLessThan(0);

        const after = await loadFilePayload(projectId, rel);
        expect(after).toBeNull();
      } finally {
        try {
          fs.rmSync(path.join(fixture.root, "svc"), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "keeps a changed extensionless file's payload when its head-read fails transiently",
      async () => {
        const rel = "ro/probe";
        const abs = path.join(fixture.root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Readable code first → gets a persisted payload with symbols.
        fs.writeFileSync(abs, "def a():\n    return b()\n\ndef b():\n    return 1\n", "utf-8");
        try {
          await rebuildGraph(fixture.root);
          const before = await loadFilePayload(projectId, rel);
          expect(before).toBeTruthy();
          expect((before?.symbols ?? []).map((s) => s.name)).toContain("a");

          // Now make the head-read fail (EACCES). A transient read failure must
          // NOT be read as "lost grammar": the payload must survive, mirroring
          // the extensioned readFile-catch path (an extensioned file with the
          // same error keeps its payload).
          fs.chmodSync(abs, 0o000);
          const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });
          const result = await updateChangedFilesSymbolGraph(projectId, fixture.root, graph, [rel], []);
          expect(result.filesRemoved).toBe(0);

          const after = await loadFilePayload(projectId, rel);
          expect(after).toBeTruthy();
          expect((after?.symbols ?? []).map((s) => s.name)).toContain("a");
        } finally {
          try {
            fs.chmodSync(abs, 0o644);
          } catch {
            /* ignore */
          }
          try {
            fs.rmSync(path.join(fixture.root, "ro"), { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      },
    );
  },
);
