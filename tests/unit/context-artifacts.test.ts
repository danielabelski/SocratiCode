// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextCollectionName } from "../../src/config.js";
import {
  chunkArtifactContent,
  loadConfig,
  readArtifactContent,
} from "../../src/services/context-artifacts.js";

// ── Temp directory helpers ────────────────────────────────────────────────

let tempDir: string;

beforeAll(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-context-test-"));
});

afterAll(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

async function createTempProject(
  files: Record<string, string>,
): Promise<string> {
  const projectDir = path.join(tempDir, `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(projectDir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(projectDir, filePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content);
  }
  return projectDir;
}

// ── loadConfig ─────────────────────────────────────────────────────────

describe("loadConfig", () => {
  it("returns null when no .socraticodecontextartifacts.json exists", async () => {
    const projectDir = await createTempProject({ "README.md": "# Hello" });
    // Point global fallback to a non-existent directory so we only test project-level
    const originalEnv = process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
    process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = path.join(tempDir, "nonexistent-global");
    try {
      const config = await loadConfig(projectDir);
      expect(config).toBeNull();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
      } else {
        process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = originalEnv;
      }
    }
  });

  it("parses a valid .socraticodecontextartifacts.json", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [
          {
            name: "db-schema",
            path: "./schema.sql",
            description: "Database schema",
          },
        ],
      }),
    });
    const config = await loadConfig(projectDir);
    expect(config).not.toBeNull();
    expect(config?.artifacts).toHaveLength(1);
    expect(config?.artifacts?.[0].name).toBe("db-schema");
    expect(config?.artifacts?.[0].path).toBe("./schema.sql");
    expect(config?.artifacts?.[0].description).toBe("Database schema");
  });

  it("accepts config without artifacts key", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({}),
    });
    const config = await loadConfig(projectDir);
    expect(config).not.toBeNull();
    expect(config?.artifacts).toBeUndefined();
  });

  it("accepts multiple artifacts", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [
          { name: "schema", path: "./schema.sql", description: "DB schema" },
          { name: "api", path: "./api.yaml", description: "API spec" },
          { name: "infra", path: "./terraform/", description: "Infra configs" },
        ],
      }),
    });
    const config = await loadConfig(projectDir);
    expect(config?.artifacts).toHaveLength(3);
  });

  it("throws on invalid JSON", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": "{ not valid json }",
    });
    await expect(loadConfig(projectDir)).rejects.toThrow("not valid JSON");
  });

  it("throws when root is not an object", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify([1, 2, 3]),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow("must be a JSON object");
  });

  it("throws when artifacts is not an array", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({ artifacts: "not-an-array" }),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow('"artifacts" must be an array');
  });

  it("throws when artifact is missing name", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [{ path: "./schema.sql", description: "DB" }],
      }),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow("name must be a non-empty string");
  });

  it("throws when artifact has empty name", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [{ name: "  ", path: "./schema.sql", description: "DB" }],
      }),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow("name must be a non-empty string");
  });

  it("throws when artifact is missing path", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [{ name: "schema", description: "DB" }],
      }),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow("path must be a non-empty string");
  });

  it("throws when artifact is missing description", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [{ name: "schema", path: "./schema.sql" }],
      }),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow("description must be a non-empty string");
  });

  it("falls back to global config when project-level config is absent", async () => {
    const projectDir = await createTempProject({ "README.md": "# Hello" });
    // Create a global config directory with a config file
    const globalDir = path.join(tempDir, `global-${Date.now()}`);
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(
      path.join(globalDir, ".socraticodecontextartifacts.json"),
      JSON.stringify({
        artifacts: [
          { name: "shared-schema", path: "./shared/schema.sql", description: "Shared DB schema" },
        ],
      }),
    );

    // Override the env var to point to our temp global dir
    const originalEnv = process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
    process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = globalDir;
    try {
      const config = await loadConfig(projectDir);
      expect(config).not.toBeNull();
      expect(config?.artifacts).toHaveLength(1);
      expect(config?.artifacts?.[0].name).toBe("shared-schema");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
      } else {
        process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = originalEnv;
      }
    }
  });

  it("resolves relative artifact paths against global config dir when using fallback", async () => {
    const projectDir = await createTempProject({ "README.md": "# Hello" });
    const globalDir = path.join(tempDir, `global-resolve-${Date.now()}`);
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(
      path.join(globalDir, ".socraticodecontextartifacts.json"),
      JSON.stringify({
        artifacts: [
          { name: "relative-art", path: "docs/schema.sql", description: "Relative path artifact" },
          { name: "absolute-art", path: "/absolute/path/schema.sql", description: "Absolute path artifact" },
        ],
      }),
    );

    const originalEnv = process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
    process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = globalDir;
    try {
      const config = await loadConfig(projectDir);
      expect(config).not.toBeNull();
      const artifacts = config?.artifacts ?? [];
      // Relative path should be resolved against globalDir, not projectDir
      expect(path.isAbsolute(artifacts[0].path)).toBe(true);
      expect(artifacts[0].path).toBe(path.resolve(globalDir, "docs/schema.sql"));
      // Absolute path should remain unchanged
      expect(artifacts[1].path).toBe("/absolute/path/schema.sql");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
      } else {
        process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = originalEnv;
      }
    }
  });

  it("does NOT resolve relative paths when using project-level config", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [
          { name: "local-schema", path: "./schema.sql", description: "Local schema" },
        ],
      }),
    });
    const config = await loadConfig(projectDir);
    expect(config).not.toBeNull();
    const artifacts = config?.artifacts ?? [];
    // Project-level config should keep relative paths as-is (resolved downstream)
    expect(artifacts[0].path).toBe("./schema.sql");
  });

  it("prefers project-level config over global config", async () => {
    const globalDir = path.join(tempDir, `global-priority-${Date.now()}`);
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(
      path.join(globalDir, ".socraticodecontextartifacts.json"),
      JSON.stringify({
        artifacts: [
          { name: "global-schema", path: "./global.sql", description: "Global" },
        ],
      }),
    );
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [
          { name: "project-schema", path: "./project.sql", description: "Project" },
        ],
      }),
    });

    const originalEnv = process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
    process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = globalDir;
    try {
      const config = await loadConfig(projectDir);
      expect(config).not.toBeNull();
      expect(config?.artifacts?.[0].name).toBe("project-schema");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SOCRATICODE_GLOBAL_CONFIG_DIR;
      } else {
        process.env.SOCRATICODE_GLOBAL_CONFIG_DIR = originalEnv;
      }
    }
  });

  it("throws on duplicate artifact names (case-insensitive)", async () => {
    const projectDir = await createTempProject({
      ".socraticodecontextartifacts.json": JSON.stringify({
        artifacts: [
          { name: "Schema", path: "./a.sql", description: "First" },
          { name: "schema", path: "./b.sql", description: "Second" },
        ],
      }),
    });
    await expect(loadConfig(projectDir)).rejects.toThrow('duplicate artifact name "schema"');
  });
});

// ── readArtifactContent ─────────────────────────────────────────────────

describe("readArtifactContent", () => {
  it("reads a single file and returns content + hash", async () => {
    const projectDir = await createTempProject({
      "schema.sql": "CREATE TABLE users (id INT PRIMARY KEY);",
    });
    const { content, contentHash } = await readArtifactContent("./schema.sql", projectDir);
    expect(content).toBe("CREATE TABLE users (id INT PRIMARY KEY);");
    expect(contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns deterministic hash for same content", async () => {
    const projectDir = await createTempProject({
      "a.sql": "SELECT 1;",
      "b.sql": "SELECT 1;",
    });
    const r1 = await readArtifactContent("./a.sql", projectDir);
    const r2 = await readArtifactContent("./b.sql", projectDir);
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  it("returns different hashes for different content", async () => {
    const projectDir = await createTempProject({
      "a.sql": "SELECT 1;",
      "b.sql": "SELECT 2;",
    });
    const r1 = await readArtifactContent("./a.sql", projectDir);
    const r2 = await readArtifactContent("./b.sql", projectDir);
    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  it("reads a directory and concatenates files with headers", async () => {
    const projectDir = await createTempProject({
      "deploy/service.yaml": "apiVersion: v1\nkind: Service",
      "deploy/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment",
    });
    const { content, contentHash } = await readArtifactContent("./deploy", projectDir);
    expect(content).toContain("# ── deployment.yaml ──");
    expect(content).toContain("# ── service.yaml ──");
    expect(content).toContain("kind: Service");
    expect(content).toContain("kind: Deployment");
    expect(contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reads nested directory files recursively", async () => {
    const projectDir = await createTempProject({
      "infra/main.tf": 'resource "aws_s3_bucket" "bucket" {}',
      "infra/modules/vpc/main.tf": 'resource "aws_vpc" "main" {}',
    });
    const { content } = await readArtifactContent("./infra", projectDir);
    expect(content).toContain("aws_s3_bucket");
    expect(content).toContain("aws_vpc");
  });

  it("throws for nonexistent path", async () => {
    const projectDir = await createTempProject({});
    await expect(readArtifactContent("./missing.sql", projectDir)).rejects.toThrow();
  });

  it("throws for empty directory", async () => {
    const projectDir = await createTempProject({});
    await fsp.mkdir(path.join(projectDir, "empty-dir"), { recursive: true });
    await expect(readArtifactContent("./empty-dir", projectDir)).rejects.toThrow("empty or contains no readable files");
  });

  it("supports absolute paths", async () => {
    const projectDir = await createTempProject({
      "data.json": '{"key": "value"}',
    });
    const absPath = path.join(projectDir, "data.json");
    const { content } = await readArtifactContent(absPath, projectDir);
    expect(content).toBe('{"key": "value"}');
  });
});

// ── readArtifactContent: directory exclusions ───────────────────────────
//
// A directory artifact used to embed whatever the walk found, including
// compiled bytecode: `readFile(path, "utf-8")` never throws on binary input,
// so the `catch` that was meant to skip it could not fire. These cover both
// halves of the fix — the ignore chain and the binary guard — and pin the
// boundaries each must not cross.

describe("readArtifactContent — directory exclusions", () => {
  /**
   * A .pyc-shaped buffer: CPython magic, the NUL bytes of its header, a marshal
   * byte that is not valid UTF-8, then a readable docstring. The docstring is
   * the point — marshal keeps string constants legible, which is what BM25
   * matched when bytecode reached the index.
   */
  const PYC_BYTES = Buffer.concat([
    Buffer.from([0x6f, 0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00, 0xe3, 0x00, 0x80]),
    Buffer.from("upgrade the users table", "latin1"),
  ]);

  async function writeBytes(dir: string, relPath: string, buf: Buffer): Promise<void> {
    const fullPath = path.join(dir, relPath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, buf);
  }

  it("applies all three ignore layers, with no binary involved", async () => {
    const projectDir = await createTempProject({
      "versions/001_init.py": "def upgrade(): pass",
      // One fixture per layer, each matched by a pattern the other two layers
      // do not carry, so a regression in any single layer fails this test.
      "versions/coverage/report.txt": "COVERAGE_MARKER", // layer 1: defaults
      "versions/__pycache__/001_init.txt": "PYCACHE_MARKER", // layer 1: defaults
      "versions/.gitignore": "notes-draft.txt\n", // layer 2
      "versions/notes-draft.txt": "GITIGNORE_MARKER",
      "versions/.socraticodeignore": "scratch.txt\n", // layer 3
      "versions/scratch.txt": "SCRATCH_MARKER",
    });

    // Layer 2 is env-gated; pin it on explicitly so neither a host shell
    // setting nor the default in ignore.ts decides whether this test is
    // exercising the .gitignore layer at all.
    const originalEnv = process.env.RESPECT_GITIGNORE;
    process.env.RESPECT_GITIGNORE = "true";
    let content: string;
    try {
      ({ content } = await readArtifactContent("./versions", projectDir));
    } finally {
      if (originalEnv === undefined) {
        delete process.env.RESPECT_GITIGNORE;
      } else {
        process.env.RESPECT_GITIGNORE = originalEnv;
      }
    }

    expect(content).toContain("def upgrade()");
    // Every excluded file here is plain text — the binary guard cannot be
    // what removed them, so the chain is demonstrably live on its own.
    expect(content).not.toContain("COVERAGE_MARKER");
    expect(content).not.toContain("PYCACHE_MARKER");
    expect(content).not.toContain("GITIGNORE_MARKER");
    expect(content).not.toContain("SCRATCH_MARKER");
    // dot: false — the ignore files themselves are never walked, so they
    // cannot be embedded as artifact content.
    expect(content).not.toContain(".socraticodeignore");
    expect(content).not.toContain(".gitignore");
  });

  it("skips a top-level binary with no ignore pattern involved", async () => {
    const projectDir = await createTempProject({
      "specs/openapi.yaml": "openapi: 3.0.0",
    });
    // .bin matches nothing in the ignore chain — only the guard can drop it.
    await writeBytes(projectDir, "specs/payload.bin", PYC_BYTES);

    const { content } = await readArtifactContent("./specs", projectDir);
    expect(content).toContain("openapi: 3.0.0");
    expect(content).not.toContain("upgrade the users table");
    expect(content).not.toContain("payload.bin");
  });

  it("keeps a latin1 text file rather than dropping it whole", async () => {
    const projectDir = await createTempProject({});
    // 0xE9 is "é" in latin1 and invalid UTF-8. A fatal decoder would reject the
    // file entirely; the NUL sniff keeps it, losing only the undecodable byte.
    await writeBytes(
      projectDir,
      "docs/notes.md",
      Buffer.from("café architecture notes", "latin1"),
    );

    const { content } = await readArtifactContent("./docs", projectDir);
    expect(content).toContain("architecture notes");
    expect(content).toContain("caf");
  });

  it("skips UTF-16 with a BOM, matching the indexer's Stage-0 guard", async () => {
    const projectDir = await createTempProject({
      "specs/readable.yaml": "kind: Service",
    });
    await writeBytes(
      projectDir,
      "specs/utf16.yaml",
      Buffer.from("\uFEFFkind: Deployment", "utf16le"),
    );

    const { content } = await readArtifactContent("./specs", projectDir);
    expect(content).toContain("kind: Service");
    // Assert on the per-file header, not on the UTF-16 text: decoded as UTF-8
    // those bytes are NUL-interleaved, so a "kind: Deployment" substring check
    // would pass whether the file was embedded or not.
    expect(content).not.toContain("utf16.yaml");
  });

  it("still throws loudly for a directory of only binaries", async () => {
    const projectDir = await createTempProject({});
    await writeBytes(projectDir, "versions/a.bin", PYC_BYTES);
    await writeBytes(projectDir, "versions/b.bin", PYC_BYTES);

    await expect(readArtifactContent("./versions", projectDir)).rejects.toThrow(
      "empty or contains no readable files",
    );
    // The throw names what went missing, so the failure is actionable.
    await expect(readArtifactContent("./versions", projectDir)).rejects.toThrow("2 binary");
  });

  it("leaves a declared single-file binary artifact untouched", async () => {
    const projectDir = await createTempProject({});
    await writeBytes(projectDir, "blob.pyc", PYC_BYTES);

    // A declared path is an explicit instruction: it must not gain a silent
    // skip, even though the same bytes are excluded from a directory walk.
    const { content, contentHash } = await readArtifactContent("./blob.pyc", projectDir);
    expect(content).toContain("upgrade the users table");
    expect(contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("lets a .socraticodeignore negation re-include a default-excluded directory", async () => {
    const projectDir = await createTempProject({
      // "env" is a built-in default pattern, but an artifact directory may
      // legitimately hold per-environment manifests under that name.
      "deploy/service.yaml": "kind: Service",
      "deploy/env/prod.yaml": "PROD_MANIFEST_MARKER",
      "deploy/.socraticodeignore": "!env\n",
    });
    const { content } = await readArtifactContent("./deploy", projectDir);
    expect(content).toContain("PROD_MANIFEST_MARKER");
  });

  it("reports what it excluded, by reason", async () => {
    const projectDir = await createTempProject({
      "versions/001_init.py": "def upgrade(): pass",
      "versions/coverage/report.txt": "COVERAGE_MARKER",
    });
    await writeBytes(projectDir, "versions/payload.bin", PYC_BYTES);

    const { exclusions } = await readArtifactContent("./versions", projectDir);
    expect(exclusions).toEqual({ ignored: 1, binary: 1, unreadable: 0 });
  });

  // Creating a symlink on Windows needs developer mode or elevation; CI is
  // ubuntu-only, so guard rather than reach for chmod, which root ignores.
  it.skipIf(process.platform === "win32")("counts a file it cannot read at all, and keeps its siblings", async () => {
    const projectDir = await createTempProject({
      "specs/real.yaml": "kind: Service",
    });
    // A dangling symlink is the portable way to reach the third counter: glob
    // yields it (nodir: true does not resolve the target) and the read throws
    // ENOENT — no chmod, which root would ignore anyway.
    await fsp.symlink("./nonexistent-target", path.join(projectDir, "specs", "dangling.yaml"));

    const { content, exclusions } = await readArtifactContent("./specs", projectDir);
    expect(exclusions).toEqual({ ignored: 0, binary: 0, unreadable: 1 });
    expect(content).toContain("kind: Service");
    expect(content).not.toContain("dangling.yaml");
  });

  it("reports no exclusions for a single-file artifact", async () => {
    const projectDir = await createTempProject({ "schema.sql": "SELECT 1;" });
    const { exclusions } = await readArtifactContent("./schema.sql", projectDir);
    expect(exclusions).toEqual({ ignored: 0, binary: 0, unreadable: 0 });
  });

  it("hashes exactly the content it returns", async () => {
    const mixed = await createTempProject({
      "versions/001_init.py": "def upgrade(): pass",
      "versions/__pycache__/001_init.txt": "PYCACHE_MARKER",
    });
    await writeBytes(mixed, "versions/001_init.pyc", PYC_BYTES);

    // A directory holding only the files that survive exclusion, byte for byte.
    const clean = await createTempProject({
      "versions/001_init.py": "def upgrade(): pass",
    });

    const mixedResult = await readArtifactContent("./versions", mixed);
    const cleanResult = await readArtifactContent("./versions", clean);

    // Same content and same hash: the staleness hash covers the indexed content
    // and nothing else, so the two cannot drift apart.
    expect(mixedResult.content).toBe(cleanResult.content);
    expect(mixedResult.contentHash).toBe(cleanResult.contentHash);
  });

  it("does not report staleness when only excluded build output changes", async () => {
    const projectDir = await createTempProject({
      "versions/001_init.py": "def upgrade(): pass",
    });
    const before = await readArtifactContent("./versions", projectDir);

    await writeBytes(projectDir, "versions/__pycache__/001_init.pyc", PYC_BYTES);
    const after = await readArtifactContent("./versions", projectDir);

    expect(after.contentHash).toBe(before.contentHash);
  });
});

// ── chunkArtifactContent ────────────────────────────────────────────────

describe("chunkArtifactContent", () => {
  it("returns a single chunk for small content", () => {
    const content = "CREATE TABLE users (\n  id INT PRIMARY KEY,\n  name TEXT\n);";
    const chunks = chunkArtifactContent(content, "schema", "./schema.sql");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].artifactName).toBe("schema");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(4);
  });

  it("produces valid UUID chunk IDs", () => {
    const content = "line1\nline2\nline3";
    const chunks = chunkArtifactContent(content, "test", "./test.txt");
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(uuidPattern);
    }
  });

  it("produces deterministic IDs for same inputs", () => {
    const content = "CREATE TABLE t1;\nCREATE TABLE t2;";
    const chunks1 = chunkArtifactContent(content, "schema", "./schema.sql");
    const chunks2 = chunkArtifactContent(content, "schema", "./schema.sql");
    expect(chunks1.map((c) => c.id)).toEqual(chunks2.map((c) => c.id));
  });

  it("splits large content into multiple overlapping chunks", () => {
    // Generate short lines so we don't hit MAX_CHUNK_CHARS truncation
    const lines = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const content = lines.join("\n");
    const chunks = chunkArtifactContent(content, "schema", "./schema.sql");

    expect(chunks.length).toBeGreaterThan(1);

    // Verify overlap: last lines of chunk N should overlap with first lines of chunk N+1
    // CHUNK_SIZE = 100, CHUNK_OVERLAP = 10
    for (let i = 0; i < chunks.length - 1; i++) {
      const chunkLines = chunks[i].content.split("\n");
      const nextChunkLines = chunks[i + 1].content.split("\n");
      // The last OVERLAP lines of this chunk should appear at the start of the next
      const overlapFromCurrent = chunkLines.slice(-10);
      const overlapFromNext = nextChunkLines.slice(0, 10);
      expect(overlapFromCurrent).toEqual(overlapFromNext);
    }
  });

  it("handles empty content", () => {
    const chunks = chunkArtifactContent("", "test", "./test.txt");
    expect(chunks).toHaveLength(0);
  });

  it("handles single-line content", () => {
    const chunks = chunkArtifactContent("SELECT 1;", "test", "./test.sql");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("SELECT 1;");
  });

  it("sets correct line numbers", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkArtifactContent(content, "test", "./test.txt");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(50);
  });

  it("uses different artifactName for different artifacts", () => {
    const content = "SELECT 1;";
    const c1 = chunkArtifactContent(content, "schema-a", "./a.sql");
    const c2 = chunkArtifactContent(content, "schema-b", "./b.sql");
    expect(c1[0].artifactName).toBe("schema-a");
    expect(c2[0].artifactName).toBe("schema-b");
    // IDs should differ because artifact name and path differ
    expect(c1[0].id).not.toBe(c2[0].id);
  });

  it("splits a window that exceeds the character cap instead of dropping the tail", () => {
    // Artifacts are chunked by line count and then held to a cap counted in
    // characters, so a window of CHUNK_SIZE lines can overflow it. 30 lines of
    // 200 characters is 6030 characters in one window against a 500-char cap.
    const lines = Array.from({ length: 30 }, (_, i) => `-- ${String(i + 1).padStart(3, "0")} ${"x".repeat(194)}`);
    const content = lines.join("\n");
    const chunks = chunkArtifactContent(content, "schema", "./schema.sql", 500);

    // Every character survives, in order, and no chunk exceeds the cap.
    expect(chunks.map((c) => c.content).join("")).toBe(content);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(500);

    // Continuations are addressable: an id collision would make Qdrant's upsert
    // keep only the last piece of the window.
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const c of chunks) expect(c.id).toMatch(uuidPattern);

    // Line numbers stay inside the artifact and in order.
    expect(chunks[0].startLine).toBe(1);
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeLessThanOrEqual(lines.length);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  it("drops pieces that hold nothing but whitespace", () => {
    // A window that is mostly padding splits into pieces with no real content.
    // Each would cost an embedding call, take a point in Qdrant and compete in
    // search results. One line of SQL followed by 60 lines of spaces is the
    // shape that produces them.
    const content = ["SELECT 1;", ...Array.from({ length: 60 }, () => " ".repeat(40))].join("\n");
    const chunks = chunkArtifactContent(content, "schema", "./schema.sql", 200);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.filter((c) => c.content.trim().length === 0)).toHaveLength(0);
    // The real content is still there — dropping blanks must not drop the line
    // that mattered.
    expect(chunks.some((c) => c.content.includes("SELECT 1;"))).toBe(true);
  });

  it("rejects a cap below 1 rather than looping", () => {
    // maxChunkChars is an argument of this exported function, so a caller can
    // pass a value the env-var validation would have refused. A cap of 0 would
    // never advance the split offset.
    expect(() => chunkArtifactContent("a\nb\nc", "x", "./x.txt", 0)).toThrow(
      /maxChunkChars must be a positive integer/,
    );
  });

  it("leaves content within the cap as one chunk per window", () => {
    // The common case must not gain chunks: splitting only happens on overflow.
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkArtifactContent(content, "notes", "./notes.md", 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(30);
  });
});

// ── contextCollectionName ────────────────────────────────────────────────

describe("contextCollectionName", () => {
  it("prefixes with context_", () => {
    expect(contextCollectionName("abc123def456")).toBe("context_abc123def456");
  });

  it("produces valid Qdrant-friendly collection names", () => {
    const name = contextCollectionName("abc123def456");
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(name).toMatch(/^context_[0-9a-f]{12}$/);
  });
});
