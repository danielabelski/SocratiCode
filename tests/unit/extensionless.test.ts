// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileHead,
  resolveExtensionlessExtension,
  resolveExtensionlessExtensionStrict,
} from "../../src/services/extensionless.js";

describe("extensionless I/O helpers", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-extless-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const write = (name: string, content: string | Buffer): string => {
    const p = path.join(root, name);
    fs.writeFileSync(p, content);
    return p;
  };

  describe("readFileHead", () => {
    it("reads at most maxBytes and decodes utf-8", async () => {
      const p = write("big", "x".repeat(20000));
      const head = await readFileHead(p, 8192);
      expect(head.length).toBe(8192);
    });
    it("throws for a missing file", async () => {
      await expect(readFileHead(path.join(root, "nope"))).rejects.toThrow();
    });
    it.skipIf(process.platform === "win32")("rejects a FIFO without blocking on the open", async () => {
      // O_NONBLOCK + fstat must reject a FIFO immediately instead of blocking on
      // open("r"), independent of any lstat guard in the caller.
      const fifo = path.join(root, "rfh-pipe");
      execFileSync("mkfifo", [fifo]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            readFileHead(fifo),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("blocked on FIFO open")), 2000);
            }),
          ]),
        ).rejects.toThrow(/not a regular file/);
      } finally {
        clearTimeout(timer);
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("resolveExtensionlessExtension", () => {
    it("detects a bash probe as .sh", async () => {
      const p = write("strato-check", "#!/bin/bash\nexit 0\n");
      expect(await resolveExtensionlessExtension(p)).toBe(".sh");
    });
    it("returns null for a non-code extensionless file", async () => {
      const p = write("LICENSE", "MIT License\n\nCopyright (c) 2026\n");
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it("returns null for a binary file (NUL byte)", async () => {
      const p = write("blob", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it("returns null on read error (missing file)", async () => {
      expect(await resolveExtensionlessExtension(path.join(root, "gone"))).toBeNull();
    });
    it("returns null when the kill-switch is off", async () => {
      const p = write("probe", "#!/bin/bash\n");
      vi.stubEnv("INDEX_EXTENSIONLESS", "false");
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it("never runs detection on a SPECIAL_FILE (Makefile) even with code-like content", async () => {
      // Makefiles/Dockerfiles are extensionless but handled by name elsewhere;
      // a shell-recipe Makefile would otherwise sniff as .sh and pollute the
      // graph. It must stay out of content detection here.
      const p = write("Makefile", "build:\n\tset -euo pipefail\n\tif [ -f foo ]; then \\\n\t\techo yes; \\\n\tfi\n");
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it.skipIf(process.platform === "win32")("returns null for a FIFO without blocking on the open", async () => {
      // glob({nodir:true}) still yields FIFOs/sockets/devices, and opening a FIFO
      // for read blocks until a writer appears — which would wedge the whole scan.
      // Detection must lstat and drop non-regular files, never head-read them.
      const fifo = path.join(root, "mypipe");
      execFileSync("mkfifo", [fifo]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          resolveExtensionlessExtension(fifo),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("blocked on FIFO open")), 2000);
          }),
        ]);
        expect(result).toBeNull();
      } finally {
        clearTimeout(timer);
        // If a buggy impl left a read-open blocked, open the write end to release
        // it so the leaked threadpool op does not stall worker teardown.
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          /* no blocked reader (guard worked) → ENXIO; ignore */
        }
      }
    });
  });

  describe("resolveExtensionlessExtensionStrict", () => {
    it("throws on a read failure instead of returning null (unlike the lenient variant)", async () => {
      const missing = path.join(root, "gone");
      await expect(resolveExtensionlessExtensionStrict(missing)).rejects.toThrow();
      // The lenient variant swallows the same failure and returns null.
      expect(await resolveExtensionlessExtension(missing)).toBeNull();
    });
    it("returns null (no throw) for a readable non-code file", async () => {
      const p = write("NOTICE", "All rights reserved.\n");
      expect(await resolveExtensionlessExtensionStrict(p)).toBeNull();
    });
    it("returns the detected extension for a readable script", async () => {
      const p = write("probe", "#!/bin/bash\nexit 0\n");
      expect(await resolveExtensionlessExtensionStrict(p)).toBe(".sh");
    });
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "throws on a head-read failure (EACCES), distinct from a stat failure",
      async () => {
        // The stat-failure path is covered above (missing file → lstat throws).
        // This pins the *read*-failure path: a regular file that opens with EACCES
        // must still throw (not collapse to null), or the incremental purge guard
        // silently regresses.
        const p = write("secret", "#!/bin/bash\nexit 0\n");
        fs.chmodSync(p, 0o000);
        try {
          await expect(resolveExtensionlessExtensionStrict(p)).rejects.toThrow();
          // The lenient variant swallows the same read failure and returns null.
          expect(await resolveExtensionlessExtension(p)).toBeNull();
        } finally {
          fs.chmodSync(p, 0o644);
        }
      },
    );
  });
});
