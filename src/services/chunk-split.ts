// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { createHash } from "node:crypto";

/**
 * Splitting text at the per-chunk character cap, and the chunk ids that split
 * produces.
 *
 * Shared by the two chunkers — `chunkFileContent` for source files and
 * `chunkArtifactContent` for context artifacts — which both cut by line count
 * and then have to honour a cap counted in characters. It lives in its own
 * module because indexer.ts already imports context-artifacts.ts, so the shared
 * helper cannot live in either of them.
 */

/**
 * The index format version from which the character cap splits instead of
 * truncating.
 *
 * A collection stores the profile it was created with, and keeps it. One stored
 * below this version keeps truncating — for files that changed and for files
 * discovered after an upgrade alike — so that what is written never drifts from
 * what its persisted effective profile says.
 */
export const SPLITTING_INDEX_FORMAT_VERSION = 2;

/** Format a sha256 digest as a valid UUID (required by Qdrant): 8-4-4-4-12 */
export function uuidFromSeed(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Derive the id of a continuation piece from the id of the chunk it was split
 * out of.
 *
 * Seeded from the parent id rather than from the position it starts at, because
 * position does not identify a chunk on every path: `chunkByCharacters` gives
 * every chunk of a single-line minified file the same startLine, and an
 * artifact chunk is identified by the line its parent began on. Re-deriving
 * from position would collide across the continuations of one parent, and
 * Qdrant's upsert would silently keep only the last. Seeding from the parent id
 * is unique wherever the parent is.
 */
export function continuationId(parentId: string, part: number): string {
  // NUL separates the two fields: it cannot occur in a UUID, so no two
  // (parentId, part) pairs can produce the same seed.
  return uuidFromSeed(`${parentId}\u0000${part}`);
}

/** One piece of a split. Line numbers are 1-based within the text given. */
export interface TextPiece {
  text: string;
  startLine: number;
  endLine: number;
}

/** Boundaries considered while looking backwards inside one capped window. */
export type TextBoundaryMode = "newline" | "code-token";

/**
 * Split text into pieces of at most `maxChunkChars` characters — one more only
 * where a surrogate pair or a CRLF would otherwise be divided.
 *
 * Every character of the input appears in exactly one piece, in order:
 * concatenating `text` across the result reproduces the input.
 *
 * By default each piece ends at the last newline at or before the cap, so a
 * line is never divided and the line range stored on the chunk stays true.
 * Minified code can instead select `code-token`, which also accepts the
 * released chunker's space, tab, semicolon and comma boundaries so identifiers
 * are not divided where a safe boundary exists inside the capped window. When
 * the span holds no eligible boundary, the piece ends at the cap.
 *
 * Text at or below the cap comes back as a single piece, so callers can use
 * this unconditionally.
 */
export function splitTextToCharCap(
  content: string,
  maxChunkChars: number,
  boundaryMode: TextBoundaryMode = "newline",
): TextPiece[] {
  // A cap below 1 would leave `end` equal to `offset` and loop forever emitting
  // empty pieces. The env-var path cannot reach this (constants.ts and
  // parseEffectiveIndexProfile both reject it), but chunkFileContent and
  // chunkArtifactContent take the cap as an argument and are exported.
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error(`maxChunkChars must be a positive integer, got ${maxChunkChars}`);
  }
  if (boundaryMode !== "newline" && boundaryMode !== "code-token") {
    throw new Error(`Unknown text boundary mode: ${String(boundaryMode)}`);
  }

  const pieces: TextPiece[] = [];
  let offset = 0;
  let currentLine = 1;

  while (offset < content.length) {
    let end = Math.min(offset + maxChunkChars, content.length);

    if (end < content.length) {
      // The last eligible boundary at or before the cap: scan back from
      // `end - 1` so the boundary itself is inside the piece. Starting at
      // `end` would accept one character beyond the cap.
      //
      // Bounded at `offset` deliberately. String.lastIndexOf has no lower
      // bound, so on content holding no newline at all it would run back to
      // index 0 for every piece — quadratic in the file, where the released
      // scan was linear because it stopped at the window. That input is not
      // hypothetical: a one-line bundle is what MAX_AVG_LINE_LENGTH routes
      // here, MAX_FILE_BYTES lets it reach 5 MB, and chunking is synchronous.
      let boundary = -1;
      // The code-token mode does not select a delimiter at the first character
      // of a window: that would emit a one-character piece instead of making
      // useful progress towards the cap. The newline mode keeps that option so
      // a leading newline can remain a complete line-ending piece at cap 1.
      const firstCandidate = boundaryMode === "code-token" ? offset + 1 : offset;
      for (let i = end - 1; i >= firstCandidate; i--) {
        const code = content.charCodeAt(i);
        const eligible =
          code === 0x0a ||
          (boundaryMode === "code-token" &&
            (code === 0x20 || code === 0x09 || code === 0x3b || code === 0x2c));
        if (eligible) {
          boundary = i;
          break;
        }
      }
      if (boundary >= firstCandidate) {
        end = boundary + 1;
      } else {
        // No eligible boundary in this span: split at the cap — but never
        // through a pair that means one thing on its own.
        //
        // A surrogate pair is one character held in two UTF-16 units. Split it
        // and both halves become U+FFFD, so the character is lost — the very
        // thing this split exists to prevent. A CRLF is one line ending, and
        // splitting it leaves a blank line the file does not have.
        const before = content.charCodeAt(end - 1);
        const after = content.charCodeAt(end);
        const surrogatePair =
          before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
        const lineEnding = before === 0x0d && after === 0x0a;
        if (surrogatePair || lineEnding) {
          // Move the boundary off the pair: back one, or forward one where
          // going back would leave this piece empty.
          end = end - 1 > offset ? end - 1 : end + 1;
        }
      }
    }

    const text = content.slice(offset, end);
    const startLine = currentLine;
    const newlineCount = (text.match(/\n/g) ?? []).length;
    // A trailing newline closes the last line the piece holds; it does not open
    // another one.
    const endsWithNewline = text.endsWith("\n");
    const endLine = endsWithNewline
      ? Math.max(startLine, startLine + newlineCount - 1)
      : startLine + newlineCount;

    pieces.push({ text, startLine, endLine });

    currentLine = endsWithNewline ? endLine + 1 : endLine;
    offset = end;
  }

  return pieces;
}
