// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * I/O wrapper around the pure {@link detectExtensionlessExtension} detector.
 *
 * Kept as a leaf module (imports only the leaf modules constants + logger) so
 * the indexer, code graph, watcher, and incremental symbol-graph paths can all
 * consult content detection without introducing an import cycle.
 */

import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  DETECT_HEAD_BYTES,
  detectExtensionlessExtension,
  indexExtensionlessEnabled,
  SPECIAL_FILES,
} from "../constants.js";
import { logger } from "./logger.js";

/**
 * Read up to `maxBytes` bytes from the start of a file and decode as UTF-8.
 * Reads only the head (not the whole file) so scanning large extensionless
 * binaries/data files stays cheap. Opens non-blocking and throws for a
 * non-regular file (FIFO/socket/device) so a mistyped or swapped path can't
 * block the open; may also throw on open/read errors.
 */
export async function readFileHead(absolutePath: string, maxBytes = DETECT_HEAD_BYTES): Promise<string> {
  // Open non-blocking and reject non-regular fds. Opening a FIFO/device for read
  // can block indefinitely; an lstat-then-open guard upstream only narrows that
  // race (the path can still become a FIFO in between). O_NONBLOCK makes the open
  // return immediately, then fstat drops anything that is not a regular file
  // before we read. O_NONBLOCK has no effect on regular-file reads.
  const fh = await fsp.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) {
      throw Object.assign(new Error(`not a regular file: ${absolutePath}`), { code: "ENOTREG" });
    }
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await fh.close();
  }
}

/**
 * Like {@link resolveExtensionlessExtension} but **throws** on a read/stat
 * failure instead of collapsing it to `null`, so a caller that must not conflate
 * "unreadable" with "not code" can tell them apart — e.g. the incremental
 * symbol-graph purge, which would otherwise drop a still-valid payload on a
 * transient I/O blip. Returns `null` only for a genuine non-match: detection
 * disabled, a {@link SPECIAL_FILES} name, a non-regular file, or content that is
 * not indexable code.
 */
export async function resolveExtensionlessExtensionStrict(absolutePath: string): Promise<string | null> {
  if (!indexExtensionlessEnabled()) return null;
  // SPECIAL_FILES (Makefile, Dockerfile, …) are extensionless but handled by
  // name; never route them through content detection, so the graph paths stay
  // consistent with the index (getIndexableFiles filters them via isIndexableFile)
  // and a shell-recipe Makefile is not mis-graphed as a shell node.
  if (SPECIAL_FILES.has(path.basename(absolutePath))) return null;
  // Only a regular file can be head-read. glob({nodir:true}) still yields
  // FIFOs/sockets/devices, and opening a FIFO for read blocks until a writer
  // appears — which would wedge the whole scan. lstat and drop non-regular
  // files (the watcher's isIndexableFile guards the same way).
  const stats = await fsp.lstat(absolutePath);
  if (!stats.isFile()) return null;
  return detectExtensionlessExtension(await readFileHead(absolutePath));
}

/**
 * Detect the canonical extension of an extensionless file by head content, or
 * `null` when detection is disabled, the name is a {@link SPECIAL_FILES} entry,
 * the file is unreadable, or the content is not indexable code. Callers that
 * need graph-eligibility (grammar-bearing only) additionally check
 * `getAstGrepLang(result) !== null`.
 */
export async function resolveExtensionlessExtension(absolutePath: string): Promise<string | null> {
  try {
    return await resolveExtensionlessExtensionStrict(absolutePath);
  } catch (err) {
    // ENOENT (file deleted/renamed between scan and read) is an expected skip.
    // A non-ENOENT fault (EACCES, EIO) means a possibly-code file we could not
    // read — surface it at debug so it is not silently confused with "not code".
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.debug("Could not read extensionless file head (skipping)", {
        absolutePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}
