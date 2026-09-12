// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// MAX_CHUNK_CHARS caps every chunk regardless of chunking strategy, and the cap
// is where chunks are split rather than where they are cut short: a chunk over
// the cap becomes as many chunks as it needs, on every path. A lower cap
// therefore yields more chunks, never less indexed content.
//
// It did truncate on three of the four paths, and that dropped content outright
// — no vector, no payload, no BM25 text, so no search could retrieve it. Several
// cases below exist to keep that from coming back.
//
// MAX_CHUNK_CHARS is read once at module load in src/constants.ts, so each case
// resets the module cache and re-imports to make the env-var IIFE run again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "MAX_CHUNK_CHARS";

describe("MAX_CHUNK_CHARS", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
    vi.resetModules();
  });

  describe("default — backwards compatibility", () => {
    it("is 2000 when the variable is unset", async () => {
      delete process.env[ENV_KEY];
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });

    it("is 2000 when the variable is empty", async () => {
      process.env[ENV_KEY] = "";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });
  });

  describe("override", () => {
    it("accepts a smaller cap for short-context models", async () => {
      process.env[ENV_KEY] = "600";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(600);
    });

    // Not "a cap for long-context models": 8000 is past the effective embedding
    // limit of the default provider (nomic-embed-text at CHARS_PER_TOKEN_ESTIMATE=1.0
    // and a 2048-token context), so the provider pre-truncates and the characters
    // past that point reach the payload and the BM25 text but not the vector.
    // Validation is deliberately lower-bound only — see src/constants.ts.
    it("accepts a cap above the default provider's effective embedding limit", async () => {
      process.env[ENV_KEY] = "8000";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(8000);
    });

    // 1 is the smallest value validation allows, not a usable one: prepareDocumentText
    // prepends the document prefix, the path and a newline, so the embedded text
    // is essentially that header alone.
    it("accepts 1, the smallest value validation allows", async () => {
      process.env[ENV_KEY] = "1";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(1);
    });

    it("accepts scientific notation that resolves to an integer", async () => {
      process.env[ENV_KEY] = "2e3";
      const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });
  });

  describe("validation — a bad value fails at load, not mid-index", () => {
    for (const bad of ["0", "-100", "abc", "1.5", " ", "1_000"]) {
      it(`rejects ${JSON.stringify(bad)}`, async () => {
        process.env[ENV_KEY] = bad;
        await expect(import("../../src/constants.js")).rejects.toThrow(
          /Invalid MAX_CHUNK_CHARS/,
        );
      });
    }

    it("names the offending value and the default in the message", async () => {
      process.env[ENV_KEY] = "nope";
      const err = await import("../../src/constants.js").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('"nope"');
      expect(err?.message).toContain("2000");
    });
  });

  describe("the cap is what chunking actually applies", () => {
    it("splits an over-long chunk at the configured cap", async () => {
      process.env[ENV_KEY] = "120";
      const { chunkFileContent } = await import("../../src/services/indexer.js");
      // A single 500-char line has an average line length of exactly
      // MAX_AVG_LINE_LENGTH, so the minified heuristic (avgLineLength > 500) does
      // not fire: this takes the small-file single-chunk branch, where the cap
      // used to truncate and now splits.
      const long = "x".repeat(500);
      const chunks = chunkFileContent("/tmp/notes.txt", "notes.txt", long);
      // Every character survives, in order, across as many chunks as the cap needs.
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((c) => c.content).join("")).toBe(long);
      for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(120);
    });

    it("keeps the same content in total whatever the cap is", async () => {
      // The regression test for the truncation bug: the cap decides how the
      // content is divided, never how much of it is kept. 62 short lines sit
      // below CHUNK_SIZE and well below MAX_AVG_LINE_LENGTH, so this takes the
      // small-file single-chunk branch, which is where truncation used to bite.
      const body = ["function a() {", ...Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`), "}"].join("\n");

      const totalAt = async (cap: string) => {
        process.env[ENV_KEY] = cap;
        vi.resetModules();
        const { chunkFileContent } = await import("../../src/services/indexer.js");
        return chunkFileContent("/tmp/sample.txt", "sample.txt", body)
          .reduce((n, c) => n + c.content.length, 0);
      };

      // 200 splits the body into several chunks, 4000 leaves it whole. Both hold
      // every character of it. The split adds no characters either — the pieces
      // are slices, so the totals match exactly rather than merely both being
      // "at least body.length".
      expect(await totalAt("200")).toBe(body.length);
      expect(await totalAt("4000")).toBe(body.length);
    });

    it("ends a piece at the last newline at or before the cap", async () => {
      // The rule the split follows: a line is never divided, so the line range
      // stored on each chunk stays true. The newline itself stays with the
      // piece that ends on it.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      // Lines of 10 characters including the newline. A 25-character cap can
      // hold two whole lines and part of a third, so the split lands after the
      // second.
      const content = `${["aaaaaaaaa", "bbbbbbbbb", "ccccccccc", "ddddddddd"].join("\n")}\n`;
      const pieces = splitTextToCharCap(content, 25);

      expect(pieces.map((p) => p.text).join("")).toBe(content);
      for (const piece of pieces) {
        expect(piece.text.length).toBeLessThanOrEqual(25);
        // Every piece but a final one without a trailing newline ends on one.
        expect(piece.text.endsWith("\n")).toBe(true);
      }
    });

    it("splits at the cap when the span holds no newline", async () => {
      // A minified bundle or one very long line offers no newline to end on.
      // The piece then ends at the cap rather than running past it.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      const content = "x".repeat(2002);
      const pieces = splitTextToCharCap(content, 2000);

      expect(pieces.map((p) => p.text).join("")).toBe(content);
      expect(pieces.map((p) => p.text.length)).toEqual([2000, 2]);
    });

    it("keeps truncating for a collection stored as format 0 or 1", async () => {
      // A collection keeps the representation it was created with. Splitting is
      // the format-2 representation; one stored below that must keep truncating,
      // or what is written drifts from what its persisted profile says.
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // One window of 100 lines, 40 characters each: far past a 2000 cap. The
      // marker sits past the cap, so truncation drops it.
      const body = Array(99).fill("x".repeat(39)).join("\n");
      const content = `${body}\nzarquonTailMarker`;

      const { chunkId } = await import("../../src/services/indexer.js");

      for (const indexFormatVersion of [0, 1]) {
        const chunks = chunkFileContent("/test/big.ts", "big.ts", content, {
          maxChunkChars: 2000,
          indexFormatVersion,
        });

        // The released output, byte for byte: one chunk holding the first 2000
        // characters, claiming the lines it was cut from, with the id seeded
        // from the line it starts at. Checking only the length and the absent
        // marker would pass on an id or a line range that had quietly moved,
        // which is the drift an existing collection cannot survive.
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe(content.slice(0, 2000));
        expect([chunks[0].startLine, chunks[0].endLine]).toEqual([1, 100]);
        expect(chunks[0].id).toBe(chunkId("big.ts", 1));
        expect(chunks[0].content).not.toContain("zarquonTailMarker");
      }
    });

    it("reproduces the released line-based output for format 0 and 1", async () => {
      // Past CHUNK_SIZE lines the line-based path opens further windows, each
      // truncated on its own. Their ids and line ranges are what an existing
      // collection addresses its points by, so they have to come out as
      // released — not merely within the cap.
      const { chunkFileContent, chunkId } = await import("../../src/services/indexer.js");

      // 250 lines of 39 characters: three overlapping windows, each far past a
      // 2000 cap, with an average line length well below MAX_AVG_LINE_LENGTH.
      const lines = Array.from(
        { length: 250 },
        (_, i) => `${String(i + 1).padStart(4, "0")}${"z".repeat(35)}`,
      );
      const content = lines.join("\n");

      for (const indexFormatVersion of [0, 1]) {
        const chunks = chunkFileContent("/test/long.txt", "long.txt", content, {
          maxChunkChars: 2000,
          indexFormatVersion,
        });

        expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
          [1, 100], [91, 190], [181, 250],
        ]);
        expect(chunks.map((c) => c.id)).toEqual(
          [1, 91, 181].map((startLine) => chunkId("long.txt", startLine)),
        );
        // Each chunk is its own window truncated at the cap, exactly as released.
        expect(chunks.map((c) => c.content)).toEqual(
          [0, 90, 180].map((start) =>
            lines.slice(start, Math.min(start + 100, lines.length)).join("\n").slice(0, 2000),
          ),
        );
      }
    });

    it("splits for a collection stored as format 2", async () => {
      // The same input on a fresh collection: the tail past the cap reaches a chunk.
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      const body = Array(99).fill("x".repeat(39)).join("\n");
      const content = `${body}\nzarquonTailMarker`;

      const chunks = chunkFileContent("/test/big.ts", "big.ts", content, {
        maxChunkChars: 2000,
        indexFormatVersion: 2,
      });

      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(2000);
      }
      expect(chunks.some((c) => c.content.includes("zarquonTailMarker"))).toBe(true);
    });

    it("gates artifact chunking on the stored format too", async () => {
      // The context path has the same guarantee and the same cap.
      const { chunkArtifactContent } = await import("../../src/services/context-artifacts.js");

      const body = Array(99).fill("y".repeat(39)).join("\n");
      const content = `${body}\nzarquonTailMarker`;

      for (const indexFormatVersion of [0, 1]) {
        const chunks = chunkArtifactContent(content, "notes", "notes.md", 2000, indexFormatVersion);

        // The released output, byte for byte. The id is the released value for
        // this artifact name, path and window start: an artifact point is
        // addressed by it, so it must not move for an existing collection.
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe(content.slice(0, 2000));
        expect([chunks[0].startLine, chunks[0].endLine]).toEqual([1, 100]);
        expect(chunks[0].id).toBe("dec719d1-7e32-3a25-4612-2c18ccd5d47a");
        expect(chunks[0].content).not.toContain("zarquonTailMarker");
      }

      const fresh = chunkArtifactContent(content, "notes", "notes.md", 2000, 2);
      for (const chunk of fresh) {
        expect(chunk.content.length).toBeLessThanOrEqual(2000);
      }
      expect(fresh.some((c) => c.content.includes("zarquonTailMarker"))).toBe(true);
    });

    it("reproduces the released boundaries, ids and line ranges for format 0 and 1", async () => {
      // The minified path decides where every chunk begins, and the chunk id is
      // seeded from that byte offset. Reproducing the bytes is not enough: a
      // different boundary set, or a different line counter, gives an existing
      // collection different ids and line ranges on its next incremental update
      // — the drift the version gate exists to prevent.
      //
      // The expected values below are the released v1.13.x output: the scan
      // looks for a newline, space, tab, semicolon or comma starting at the
      // limit itself, and the line counter only advances past a chunk that ends
      // on a newline.
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // Six 600-character lines. Every line is far longer than
      // MAX_AVG_LINE_LENGTH, so this takes the minified path.
      const line = "x".repeat(599);
      const content = `${Array(6).fill(line).join("\n")}\n`;

      for (const indexFormatVersion of [0, 1]) {
        const chunks = chunkFileContent("/test/min.js", "min.js", content, {
          maxChunkChars: 700,
          indexFormatVersion,
        });

        // Boundaries: each chunk ends just past a newline, because the scan
        // finds one within the window.
        expect(chunks.map((c) => c.content.length)).toEqual([600, 600, 600, 600, 600, 600]);

        // Line ranges: the released counter advances only past a newline, so a
        // chunk that ends on one starts the next chunk two lines on.
        expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
          [1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12],
        ]);

        // Ids: seeded from the byte offset each chunk starts at.
        const { chunkId } = await import("../../src/services/indexer.js");
        expect(chunks.map((c) => c.id)).toEqual(
          [0, 600, 1200, 1800, 2400, 3000].map((offset) => chunkId("min.js", offset)),
        );

        expect(chunks.map((c) => c.content).join("")).toBe(content);
      }
    });

    it("keeps token-safe delimiters for fresh minified chunks", async () => {
      // The released scan accepts a space, tab, semicolon or comma as well as a
      // newline. Fresh indexes keep those boundaries so the character cap does
      // not divide an identifier when a safe split exists inside the window.
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      const identifier = "getUserSettlementFactor";
      const content = `${"a".repeat(579)};${identifier}(${"c".repeat(900)})`;

      const legacy = chunkFileContent("/test/min.js", "min.js", content, {
        maxChunkChars: 600,
        indexFormatVersion: 0,
      });
      const fresh = chunkFileContent("/test/min.js", "min.js", content, {
        maxChunkChars: 600,
        indexFormatVersion: 2,
      });

      // A hard split at 600 would cut through the identifier. Both paths end
      // at the semicolon instead, leaving the complete identifier searchable
      // in the next chunk.
      expect(legacy[0].content.endsWith(";")).toBe(true);
      expect(fresh[0].content.endsWith(";")).toBe(true);
      expect(fresh.some((chunk) => chunk.content.includes(identifier))).toBe(true);
      for (const chunk of fresh) expect(chunk.content.length).toBeLessThanOrEqual(600);

      // Neither loses a character.
      expect(legacy.map((c) => c.content).join("")).toBe(content);
      expect(fresh.map((c) => c.content).join("")).toBe(content);
    });

    it("stores a whitespace-only artifact window for format 0 and 1", async () => {
      // The released artifact chunker pushed every window, including one holding
      // nothing but whitespace. Dropping it here would delete a point from a
      // collection that still declares the legacy format.
      const { chunkArtifactContent } = await import("../../src/services/context-artifacts.js");

      const whitespaceOnly = Array(150).fill("   ").join("\n");

      for (const indexFormatVersion of [0, 1]) {
        const chunks = chunkArtifactContent(
          whitespaceOnly, "notes", "notes.md", 2000, indexFormatVersion,
        );
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.every((c) => c.content.trim().length === 0)).toBe(true);
      }

      // Format 2 drops them: each would cost an embedding call and a point.
      const fresh = chunkArtifactContent(whitespaceOnly, "notes", "notes.md", 2000, 2);
      expect(fresh).toHaveLength(0);
    });

    it("keeps the window's line range when its last line is blank", async () => {
      // A window whose final line is blank ends on a newline, and a trailing
      // newline closes the last line rather than opening another. Deriving the
      // last piece's endLine from the piece would therefore come up a line
      // short — a chunk holding the same bytes as the released one, claiming a
      // range one line narrower. Markdown and SQL artifacts put blank lines
      // between paragraphs and statements, so this is the ordinary case.
      const { chunkArtifactContent } = await import("../../src/services/context-artifacts.js");

      // 250 lines with the 100th and 190th blank: the first two windows both
      // end on a blank line. Nothing here exceeds a 2000 cap, so no split
      // happens and the output has to match the released one exactly.
      const lines = Array.from({ length: 250 }, (_, i) =>
        i === 99 || i === 189 ? "" : `line ${i + 1}`,
      );
      const chunks = chunkArtifactContent(lines.join("\n"), "notes", "notes.md", 2000, 2);

      expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
        [1, 100], [91, 190], [181, 250],
      ]);
    });

    it("lets the last piece of a split chunk reach the parent's last line", async () => {
      // The same rule on the code side: the pieces together cover the parent
      // exactly, so the final one ends where the parent ended even when the
      // parent's last line is blank.
      process.env[ENV_KEY] = "600";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // 250 lines of 40 characters with every 100th blank, so each 100-line
      // window is past the cap and ends on a blank line.
      const lines = Array.from({ length: 250 }, (_, i) =>
        (i + 1) % 100 === 0 ? "" : `${String(i + 1).padStart(4, "0")}${"z".repeat(35)}`,
      );
      const chunks = chunkFileContent("/tmp/long.txt", "long.txt", lines.join("\n"));

      // Windows start every CHUNK_SIZE - CHUNK_OVERLAP lines, and each window's
      // last piece has to end on the window's own last line.
      expect(chunks.map((c) => c.endLine)).toContain(100);
      expect(chunks.map((c) => c.endLine)).toContain(190);
      expect(chunks.map((c) => c.endLine)).toContain(250);
      for (const c of chunks) {
        expect(c.endLine).toBeLessThanOrEqual(lines.length);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      }
    });

    it("splits newline-free content without rescanning it from the start", async () => {
      // The backward scan for a newline has to stop at the start of the piece.
      // Searching the whole string instead runs to index 0 for every piece when
      // the content holds no newline at all — quadratic in the file, where the
      // released scan was linear because it stopped at the window. A one-line
      // bundle is exactly what the minified heuristic routes to this code, and
      // MAX_FILE_BYTES lets it reach 5 MB, so this is an ordinary input rather
      // than a contrived one.
      //
      // The bound is deliberately loose: bounded scanning does this in tens of
      // milliseconds and rescanning takes seconds. Anything between the two is
      // a slow machine, not the defect.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");
      const noNewlines = "x".repeat(5 * 1024 * 1024);

      const startedAt = Date.now();
      const pieces = splitTextToCharCap(noNewlines, 2000, "code-token");
      const elapsed = Date.now() - startedAt;

      expect(pieces).toHaveLength(Math.ceil(noNewlines.length / 2000));
      expect(pieces.map((p) => p.text).join("")).toBe(noNewlines);
      expect(elapsed).toBeLessThan(1000);
    });

    it("gives every piece of a split chunk a distinct id", async () => {
      // Continuation ids are seeded from the parent id, not from (path, startLine):
      // on a single-line minified file every chunk reports startLine 1, so ids
      // re-derived from the line number would collide and Qdrant's upsert would
      // silently keep only the last one.
      process.env[ENV_KEY] = "200";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // One long line, no newline anywhere: avgLineLength >> 500 selects the
      // minified path, and every chunk it emits carries startLine 1.
      const oneLine = "abcdefghij".repeat(400); // 4000 chars, 1 line
      const chunks = chunkFileContent("/tmp/bundle.min.js", "bundle.min.js", oneLine);

      expect(chunks.length).toBeGreaterThan(1);
      expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
      for (const c of chunks) {
        expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });

    it("never accepts the character at the limit as a boundary", async () => {
      // The backwards scan used to start at the limit itself rather than one
      // before it, so a boundary character sitting exactly there produced a
      // piece of cap + 1. Truncation hid that; splitting would turn the
      // overflow into a one-character chunk with its own vector.
      //
      // This calls the splitter directly. Going through chunkFileContent no
      // longer reaches the case: the even division makes the first window
      // smaller than the cap, so nothing lands on the limit.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      // 200 characters exactly, with a comma at index 100 — the limit of the
      // first window when the text divides into two pieces of 100.
      const content = `${"x".repeat(100)},${"y".repeat(99)}`;
      const pieces = splitTextToCharCap(content, 100, "code-token");

      for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(100);
      expect(pieces.map((p) => p.text).join("")).toBe(content);
    });

    it("does not let a minified chunk claim a line the file does not have", async () => {
      // A trailing newline was counted as opening another line, so endLine — and
      // through currentLine, every subsequent startLine — drifted one further
      // ahead per chunk that ended on a newline. This was already wrong before
      // the cap started splitting: on v1.13.1, six 600-character lines at a
      // 1300 cap produce chunks claiming lines 1-3, 4-6 and 7-9, and the file
      // has six lines.
      process.env[ENV_KEY] = "1300";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // avgLineLength of 601 selects the minified path, where this drift shows.
      const lines = Array.from({ length: 6 }, () => "x".repeat(600));
      const content = `${lines.join("\n")}\n`;
      const chunks = chunkFileContent("/tmp/bundle.min.js", "bundle.min.js", content);

      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.startLine).toBeLessThanOrEqual(lines.length);
        expect(c.endLine).toBeLessThanOrEqual(lines.length);
      }
      // Each chunk holds two of the six lines, in order, with no gap.
      expect(chunks.map((c) => `${c.startLine}-${c.endLine}`)).toEqual(["1-2", "3-4", "5-6"]);
    });

    it("never splits a CRLF between the carriage return and the newline", async () => {
      // CRLF is one line ending, not two characters to divide. Cutting between
      // them leaves a stray "\r" at the end of one piece and starts the next
      // with a bare "\n", which reads as a blank line the file does not have.
      // Reachable only where no boundary was found and the split landed at the
      // target, which a small cap makes common.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      const content = `${Array(12).fill("const value = compute(a, b);").join("\r\n")}\r\n`;

      for (let cap = 1; cap <= 60; cap++) {
        const pieces = splitTextToCharCap(content, cap);

        for (let i = 0; i < pieces.length - 1; i++) {
          const dividedLineEnding =
            pieces[i].text.endsWith("\r") && pieces[i + 1].text.startsWith("\n");
          expect(dividedLineEnding).toBe(false);
        }
        expect(pieces.map((p) => p.text).join("")).toBe(content);
      }
    });

    it("never splits between the halves of a surrogate pair", async () => {
      // JavaScript strings are UTF-16 code units, so a character outside the
      // BMP takes two of them. Cutting between them leaves a lone surrogate at
      // the end of one piece and another at the start of the next, and both
      // become U+FFFD by the time they reach the embedding request.
      const { splitTextToCharCap } = await import("../../src/services/chunk-split.js");

      // The emoji straddles the split: 99 characters, then a surrogate pair,
      // then filler, with no boundary character anywhere to scan back to.
      const content = `${"x".repeat(99)}\u{1F600}${"y".repeat(299)}`;
      const pieces = splitTextToCharCap(content, 100);

      expect(pieces.map((p) => p.text).join("")).toBe(content);
      for (const p of pieces) {
        // A lone surrogate does not survive a UTF-8 round trip.
        expect(Buffer.from(p.text, "utf8").toString("utf8")).toBe(p.text);
      }
    });

    it("keeps the line numbers of a split chunk pointing at its own lines", async () => {
      // Truncation left the parent claiming lines it no longer held. Splitting
      // rebases each piece onto the parent's startLine instead.
      process.env[ENV_KEY] = "300";
      const { chunkFileContent } = await import("../../src/services/indexer.js");

      // 40 lines of 100 characters: 4000 chars over 40 lines keeps the average
      // line length at 100, below MAX_AVG_LINE_LENGTH, so this is the small-file
      // path rather than the minified one.
      const lines = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(3, "0")}${"z".repeat(96)}`);
      const chunks = chunkFileContent("/tmp/wide.txt", "wide.txt", lines.join("\n"));

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[chunks.length - 1].endLine).toBe(lines.length);
      for (const c of chunks) {
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
        expect(c.endLine).toBeLessThanOrEqual(lines.length);
        // The first line of each chunk is the file line its startLine names.
        const firstLine = c.content.split("\n")[0];
        if (firstLine.length === 100) expect(firstLine).toBe(lines[c.startLine - 1]);
      }
    });

    // The minified/bundled path (chunkByCharacters) reaches the cap through its
    // own splitting rather than through splitToCharCap, so it is covered
    // separately. Four lines of 3000 characters put the average line length
    // above MAX_AVG_LINE_LENGTH (500) and so select it.
    it("splits minified content into more chunks as the cap falls", async () => {
      const minified = Array.from({ length: 4 }, () => "x".repeat(3000)).join("\n");

      process.env[ENV_KEY] = "3000";
      vi.resetModules();
      const wide = await import("../../src/services/indexer.js");
      const wideChunks = wide.chunkFileContent("/tmp/bundle.js", "bundle.js", minified);

      process.env[ENV_KEY] = "500";
      vi.resetModules();
      const narrow = await import("../../src/services/indexer.js");
      const narrowChunks = narrow.chunkFileContent("/tmp/bundle.js", "bundle.js", minified);

      expect(wideChunks.length).toBeGreaterThan(0);
      expect(narrowChunks.length).toBeGreaterThan(wideChunks.length);
      for (const c of narrowChunks) {
        expect(c.content.length).toBeLessThanOrEqual(500);
      }
    });
  });
});
