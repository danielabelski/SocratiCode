// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

// Track subscriptions created by @parcel/watcher mock
let mockSubscribeCallback: ((err: Error | null, events: Array<{ path: string; type: string }>) => void) | null = null;
const mockUnsubscribe = vi.fn(async () => {});

vi.mock("@parcel/watcher", () => ({
  default: {
    subscribe: vi.fn(async (_dir: string, cb: (err: Error | null, events: Array<{ path: string; type: string }>) => void, _opts?: unknown) => {
      mockSubscribeCallback = cb;
      return { unsubscribe: mockUnsubscribe };
    }),
  },
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/services/ignore.js", () => ({
  createIgnoreFilter: vi.fn(() => ({ ignores: () => false })),
  shouldIgnore: vi.fn(() => false),
}));

const mockUpdateProjectIndex = vi.fn(async (_path: string, _progress?: unknown) => ({ added: 0, updated: 0, removed: 0, chunksCreated: 0, cancelled: false }));
const mockIsIndexingInProgress = vi.fn((_path: string) => false);
vi.mock("../../src/services/indexer.js", () => ({
  FILE_SCAN_BATCH: 50,
  updateProjectIndex: (...args: unknown[]) => mockUpdateProjectIndex(...(args as [string, unknown])),
  isIndexingInProgress: (...args: unknown[]) => mockIsIndexingInProgress(...(args as [string])),
}));

vi.mock("../../src/services/code-graph.js", () => ({
  invalidateGraphCache: vi.fn(),
}));

const mockProjectIdFromPath = vi.fn((_p: string) => "test-project-id");
const mockCollectionName = vi.fn((_id: string) => "codebase_test");
vi.mock("../../src/config.js", () => ({
  projectIdFromPath: (...args: unknown[]) => mockProjectIdFromPath(...(args as [string])),
  collectionName: (...args: unknown[]) => mockCollectionName(...(args as [string])),
}));

const mockGetCollectionInfo = vi.fn(async (_c: string): Promise<{ pointsCount: number } | null> => null);
const mockGetProjectMetadata = vi.fn(async (_c: string): Promise<Record<string, unknown> | null> => null);
vi.mock("../../src/services/qdrant.js", () => ({
  getCollectionInfo: (...args: unknown[]) => mockGetCollectionInfo(...(args as [string])),
  getProjectMetadata: (...args: unknown[]) => mockGetProjectMetadata(...(args as [string])),
}));

const mockAcquireProjectLock = vi.fn(async (_path: string, _type: string) => true);
const mockReleaseProjectLock = vi.fn(async (_path: string, _type: string) => {});
const mockIsProjectLocked = vi.fn(async (_path: string, _type: string) => false);
vi.mock("../../src/services/lock.js", () => ({
  acquireProjectLock: (...args: unknown[]) => mockAcquireProjectLock(...(args as [string, string])),
  releaseProjectLock: (...args: unknown[]) => mockReleaseProjectLock(...(args as [string, string])),
  isProjectLocked: (...args: unknown[]) => mockIsProjectLocked(...(args as [string, string])),
}));

import { shouldIgnore } from "../../src/services/ignore.js";
import { logger } from "../../src/services/logger.js";
// Import after mocks
import {
  clearExternalWatchCache,
  ensureWatcherStarted,
  getWatchedProjects,
  isIndexableFile,
  isWatchedByAnyProcess,
  isWatching,
  startWatching,
  stopAllWatchers,
  stopWatching,
} from "../../src/services/watcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const TEST_PROJECT = "/tmp/test-project";
const RESOLVED_PROJECT = path.resolve(TEST_PROJECT);

// ── Tests ────────────────────────────────────────────────────────────────

describe("watcher (unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeCallback = null;
    mockAcquireProjectLock.mockResolvedValue(true);
    mockIsProjectLocked.mockResolvedValue(false);
    mockIsIndexingInProgress.mockReturnValue(false);
    mockGetCollectionInfo.mockResolvedValue(null);
    mockGetProjectMetadata.mockResolvedValue(null);
  });

  afterEach(async () => {
    // Clean up any active watchers between tests
    await stopAllWatchers();
    clearExternalWatchCache();
  });

  // ── startWatching / stopWatching / isWatching / getWatchedProjects ───

  describe("startWatching", () => {
    it("starts watching and reports via onProgress", async () => {
      const progress: string[] = [];
      const result = await startWatching(TEST_PROJECT, (msg) => progress.push(msg));

      expect(result).toBe(true);
      expect(isWatching(TEST_PROJECT)).toBe(true);
      expect(progress).toContain(`Started watching ${RESOLVED_PROJECT}`);
      expect(logger.info).toHaveBeenCalledWith("File watcher started", { projectPath: RESOLVED_PROJECT });
    });

    it("acquires a cross-process lock", async () => {
      await startWatching(TEST_PROJECT);
      expect(mockAcquireProjectLock).toHaveBeenCalledWith(RESOLVED_PROJECT, "watch");
    });

    it("skips if already watching (idempotent)", async () => {
      const progress: string[] = [];
      await startWatching(TEST_PROJECT);
      const result = await startWatching(TEST_PROJECT, (msg) => progress.push(msg));

      expect(result).toBe(true);
      expect(progress).toContain(`Already watching ${RESOLVED_PROJECT}`);
      // subscribe should only be called once
      const watcher = await import("@parcel/watcher");
      expect(watcher.default.subscribe).toHaveBeenCalledTimes(1);
    });

    it("skips if lock cannot be acquired (another process watching)", async () => {
      mockAcquireProjectLock.mockResolvedValue(false);
      const progress: string[] = [];
      const result = await startWatching(TEST_PROJECT, (msg) => progress.push(msg));

      expect(result).toBe(false);
      expect(isWatching(TEST_PROJECT)).toBe(false);
      expect(progress.some((m) => m.includes("Another process"))).toBe(true);
    });

    it("releases lock if @parcel/watcher.subscribe fails", async () => {
      const watcher = await import("@parcel/watcher");
      vi.mocked(watcher.default.subscribe).mockRejectedValueOnce(new Error("Permission denied"));

      const progress: string[] = [];
      const result = await startWatching(TEST_PROJECT, (msg) => progress.push(msg));

      expect(result).toBe(false);
      expect(isWatching(TEST_PROJECT)).toBe(false);
      expect(mockReleaseProjectLock).toHaveBeenCalledWith(RESOLVED_PROJECT, "watch");
      expect(progress.some((m) => m.includes("Failed to start watching"))).toBe(true);
    });
  });

  describe("stopWatching", () => {
    it("stops an active watcher and releases lock", async () => {
      await startWatching(TEST_PROJECT);
      expect(isWatching(TEST_PROJECT)).toBe(true);

      await stopWatching(TEST_PROJECT);
      expect(isWatching(TEST_PROJECT)).toBe(false);
      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(mockReleaseProjectLock).toHaveBeenCalledWith(RESOLVED_PROJECT, "watch");
    });

    it("does nothing for a non-watched project", async () => {
      await expect(stopWatching("/nonexistent")).resolves.not.toThrow();
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });
  });

  describe("stopAllWatchers", () => {
    it("stops all active watchers", async () => {
      await startWatching(TEST_PROJECT);
      expect(getWatchedProjects().length).toBe(1);

      await stopAllWatchers();
      expect(getWatchedProjects()).toHaveLength(0);
    });
  });

  describe("isWatching", () => {
    it("returns false when not watching", () => {
      expect(isWatching(TEST_PROJECT)).toBe(false);
    });

    it("returns true when watching", async () => {
      await startWatching(TEST_PROJECT);
      expect(isWatching(TEST_PROJECT)).toBe(true);
    });

    it("resolves relative paths", async () => {
      await startWatching(TEST_PROJECT);
      // Should match regardless of trailing slashes etc via path.resolve
      expect(isWatching(TEST_PROJECT)).toBe(true);
    });
  });

  describe("getWatchedProjects", () => {
    it("returns empty array when nothing is watched", () => {
      expect(getWatchedProjects()).toEqual([]);
    });

    it("returns resolved paths of watched projects", async () => {
      await startWatching(TEST_PROJECT);
      const projects = getWatchedProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]).toBe(RESOLVED_PROJECT);
    });
  });

  // ── isWatchedByAnyProcess (cross-process awareness) ────────────────

  describe("isWatchedByAnyProcess", () => {
    it("returns true when watching locally", async () => {
      await startWatching(TEST_PROJECT);
      expect(await isWatchedByAnyProcess(TEST_PROJECT)).toBe(true);
    });

    it("returns true when another process holds the watch lock", async () => {
      mockIsProjectLocked.mockResolvedValue(true);
      expect(await isWatchedByAnyProcess(TEST_PROJECT)).toBe(true);
      expect(mockIsProjectLocked).toHaveBeenCalledWith(RESOLVED_PROJECT, "watch");
    });

    it("returns false when not watched locally and no lock held", async () => {
      mockIsProjectLocked.mockResolvedValue(false);
      expect(await isWatchedByAnyProcess(TEST_PROJECT)).toBe(false);
    });

    it("skips lock check when watching locally (fast path)", async () => {
      await startWatching(TEST_PROJECT);
      mockIsProjectLocked.mockClear();
      expect(await isWatchedByAnyProcess(TEST_PROJECT)).toBe(true);
      expect(mockIsProjectLocked).not.toHaveBeenCalled();
    });
  });

  // ── Event filtering (via the callback) ─────────────────────────────────

  describe("event filtering", () => {
    it("triggers update for indexable file changes", async () => {
      vi.useFakeTimers();
      const progress = vi.fn();
      await startWatching(TEST_PROJECT, progress);

      // Simulate a file change event
      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "src/app.ts"), type: "update" },
      ]);

      // Fast-forward past the debounce
      await vi.advanceTimersByTimeAsync(2100);

      expect(mockUpdateProjectIndex).toHaveBeenCalledWith(RESOLVED_PROJECT, progress);
      vi.useRealTimers();
    });

    it("ignores non-indexable files (e.g. .png, .lock)", async () => {
      vi.useFakeTimers();
      await startWatching(TEST_PROJECT);

      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "image.png"), type: "create" },
        { path: path.join(RESOLVED_PROJECT, "package-lock.json"), type: "update" },
      ]);

      // .png is not in SUPPORTED_EXTENSIONS and not in SPECIAL_FILES
      // .json IS supported, so this actually triggers — but .png is filtered

      await vi.advanceTimersByTimeAsync(2100);

      // package-lock.json has .json extension which IS in SUPPORTED_EXTENSIONS,
      // so the update should still trigger for that event
      expect(mockUpdateProjectIndex).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("ignores files that match gitignore rules", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(true);

      await startWatching(TEST_PROJECT);

      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "dist/bundle.js"), type: "create" },
      ]);

      await vi.advanceTimersByTimeAsync(2100);

      // All events were filtered by shouldIgnore, so no update
      expect(mockUpdateProjectIndex).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("ignores files outside the project tree", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(false);

      await startWatching(TEST_PROJECT);

      mockSubscribeCallback?.(null, [
        { path: "/some/other/project/file.ts", type: "update" },
      ]);

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockUpdateProjectIndex).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("handles special files (Dockerfile, Makefile)", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(false);

      await startWatching(TEST_PROJECT);

      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "Dockerfile"), type: "update" },
      ]);

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockUpdateProjectIndex).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("triggers update for a detected extensionless file event (async filter)", async () => {
      // Exercises the async event pipeline end-to-end (not just isIndexableFile
      // in isolation): a real extensionless bash probe fired as a watch event
      // must flow through the async filter to scheduleUpdate. Uses real timers +
      // waitFor rather than fake timers, since the filter does a real head-read
      // and fake-timer/real-I/O mixing races.
      fs.mkdirSync(RESOLVED_PROJECT, { recursive: true });
      const probe = path.join(RESOLVED_PROJECT, "strato-check-evt");
      fs.writeFileSync(probe, "#!/bin/bash\nexit 0\n");
      try {
        await startWatching(TEST_PROJECT);
        mockSubscribeCallback?.(null, [{ path: probe, type: "update" }]);
        await vi.waitFor(() => expect(mockUpdateProjectIndex).toHaveBeenCalled(), {
          timeout: 5000,
          interval: 50,
        });
      } finally {
        fs.rmSync(probe, { force: true });
      }
    });

    it("schedules a reconcile for an extensionless update event even when it no longer detects as code", async () => {
      // A previously-indexed extensionless file edited into readable non-code
      // still needs updateProjectIndex so its stale chunks/symbols are purged,
      // even though isIndexableFile now returns false for it.
      fs.mkdirSync(RESOLVED_PROJECT, { recursive: true });
      const stale = path.join(RESOLVED_PROJECT, "was-a-probe");
      fs.writeFileSync(stale, "Release notes: nothing here is code.\n");
      try {
        await startWatching(TEST_PROJECT);
        mockSubscribeCallback?.(null, [{ path: stale, type: "update" }]);
        await vi.waitFor(() => expect(mockUpdateProjectIndex).toHaveBeenCalled(), {
          timeout: 5000,
          interval: 50,
        });
      } finally {
        fs.rmSync(stale, { force: true });
      }
    });

    it("logs and does not crash if event filtering throws (crash-guard)", async () => {
      vi.useFakeTimers();
      try {
        // Force the filter to reject; the async callback's promise is ignored by
        // @parcel/watcher, so an unguarded rejection would crash the process.
        vi.mocked(shouldIgnore).mockImplementationOnce(() => {
          throw new Error("boom");
        });
        await startWatching(TEST_PROJECT);

        mockSubscribeCallback?.(null, [{ path: path.join(RESOLVED_PROJECT, "src/app.ts"), type: "update" }]);
        await vi.advanceTimersByTimeAsync(2100);

        expect(logger.error).toHaveBeenCalledWith(
          "Watch event filtering failed",
          expect.objectContaining({ error: "boom" }),
        );
        expect(mockUpdateProjectIndex).not.toHaveBeenCalled();
      } finally {
        // Restore real timers even if an assertion above throws, so leaked fake
        // timers can't cascade into unrelated tests.
        vi.useRealTimers();
      }
    });
  });

  // ── Debounce behavior ──────────────────────────────────────────────────

  describe("debounce", () => {
    it("coalesces rapid changes into a single update", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(false);

      await startWatching(TEST_PROJECT);

      // Fire 5 rapid events
      for (let i = 0; i < 5; i++) {
        mockSubscribeCallback?.(null, [
          { path: path.join(RESOLVED_PROJECT, `file${i}.ts`), type: "update" },
        ]);
      }

      await vi.advanceTimersByTimeAsync(2100);

      // Only one update call despite 5 events
      expect(mockUpdateProjectIndex).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("does not trigger update before debounce period", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(false);

      await startWatching(TEST_PROJECT);

      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "file.ts"), type: "update" },
      ]);

      // Only 1 second has passed — should not have triggered yet
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockUpdateProjectIndex).not.toHaveBeenCalled();

      // Now pass the debounce threshold
      await vi.advanceTimersByTimeAsync(1100);
      expect(mockUpdateProjectIndex).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("logs first 3 errors", async () => {
      await startWatching(TEST_PROJECT);

      for (let i = 0; i < 3; i++) {
        mockSubscribeCallback?.(new Error(`test error ${i}`), []);
      }

      expect(logger.error).toHaveBeenCalledTimes(3);
    });

    it("throttles error logging after 3rd error (logs every 100th)", async () => {
      await startWatching(TEST_PROJECT);

      // Fire 10 errors (below MAX_WATCHER_ERRORS threshold for this test — it will auto-stop at 10)
      // But we need to test throttling, so let's fire 4 to see the 4th is suppressed
      for (let i = 0; i < 4; i++) {
        mockSubscribeCallback?.(new Error(`error ${i}`), []);
      }

      // First 3 errors + the "too many errors" is NOT triggered yet (count=4 < 10)
      // logger.error is called for errors 1, 2, 3 but NOT 4
      const errorCalls = vi.mocked(logger.error).mock.calls.filter(
        (call) => call[0] === "File watcher error",
      );
      expect(errorCalls).toHaveLength(3);
    });

    it("auto-stops watcher after MAX_WATCHER_ERRORS consecutive errors", async () => {
      await startWatching(TEST_PROJECT);
      expect(isWatching(TEST_PROJECT)).toBe(true);

      // Fire 10 consecutive errors
      for (let i = 0; i < 10; i++) {
        mockSubscribeCallback?.(new Error(`error ${i}`), []);
      }

      // The auto-stop is asynchronous, so wait for it
      await vi.waitFor(() => {
        expect(isWatching(TEST_PROJECT)).toBe(false);
      });

      expect(logger.error).toHaveBeenCalledWith(
        "Too many watcher errors, stopping watcher",
        expect.objectContaining({ totalErrors: 10 }),
      );
    });

    it("resets error count on successful event delivery", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(false);
      await startWatching(TEST_PROJECT);

      // Fire 5 errors
      for (let i = 0; i < 5; i++) {
        mockSubscribeCallback?.(new Error(`error ${i}`), []);
      }

      // Then a successful event — error count should reset
      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "file.ts"), type: "update" },
      ]);

      // Fire 5 more errors — should NOT auto-stop (count restarted from 0)
      for (let i = 0; i < 5; i++) {
        mockSubscribeCallback?.(new Error(`error ${i}`), []);
      }

      // Should still be watching (5 + 0 + 5, but count was reset in the middle)
      expect(isWatching(TEST_PROJECT)).toBe(true);
      vi.useRealTimers();
    });
  });

  // ── ensureWatcherStarted ───────────────────────────────────────────────

  describe("ensureWatcherStarted", () => {
    it("does nothing if already watching", async () => {
      await startWatching(TEST_PROJECT);
      mockGetCollectionInfo.mockClear();

      ensureWatcherStarted(TEST_PROJECT);

      // Should not even check collection info
      expect(mockGetCollectionInfo).not.toHaveBeenCalled();
    });

    it("does nothing if indexing is in progress", () => {
      mockIsIndexingInProgress.mockReturnValue(true);

      ensureWatcherStarted(TEST_PROJECT);

      expect(mockGetCollectionInfo).not.toHaveBeenCalled();
    });

    it("does nothing if no collection exists", async () => {
      mockGetCollectionInfo.mockResolvedValue(null);

      ensureWatcherStarted(TEST_PROJECT);

      // Wait for the async chain to complete
      await vi.waitFor(() => {
        expect(mockGetCollectionInfo).toHaveBeenCalled();
      });

      // Should not have started watching
      expect(isWatching(TEST_PROJECT)).toBe(false);
    });

    it("does nothing if collection is empty (0 points)", async () => {
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 0 });

      ensureWatcherStarted(TEST_PROJECT);

      await vi.waitFor(() => {
        expect(mockGetCollectionInfo).toHaveBeenCalled();
      });

      expect(isWatching(TEST_PROJECT)).toBe(false);
    });

    it("does not start if indexing status is not completed", async () => {
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 100 });
      mockGetProjectMetadata.mockResolvedValue({
        indexingStatus: "in-progress",
        filesIndexed: 10,
        filesTotal: 50,
      });

      ensureWatcherStarted(TEST_PROJECT);

      await vi.waitFor(() => {
        expect(mockGetProjectMetadata).toHaveBeenCalled();
      });

      // Give the async chain a moment to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(isWatching(TEST_PROJECT)).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        "Skipping watcher auto-start: index is incomplete (interrupted)",
        expect.objectContaining({ indexingStatus: "in-progress" }),
      );
    });

    it("starts watcher when collection exists and index is completed", async () => {
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 100 });
      mockGetProjectMetadata.mockResolvedValue({ indexingStatus: "completed" });

      ensureWatcherStarted(TEST_PROJECT);

      await vi.waitFor(() => {
        expect(isWatching(TEST_PROJECT)).toBe(true);
      });

      expect(logger.info).toHaveBeenCalledWith(
        "Auto-started file watcher on tool use",
        expect.objectContaining({ projectPath: RESOLVED_PROJECT }),
      );
    });

    it("starts watcher when metadata is null (legacy — no metadata point)", async () => {
      // Older indexed projects may not have a metadata point at all
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 100 });
      mockGetProjectMetadata.mockResolvedValue(null);

      ensureWatcherStarted(TEST_PROJECT);

      await vi.waitFor(() => {
        expect(isWatching(TEST_PROJECT)).toBe(true);
      });
    });

    it("handles errors gracefully (non-fatal)", async () => {
      mockGetCollectionInfo.mockRejectedValue(new Error("Qdrant unreachable"));

      ensureWatcherStarted(TEST_PROJECT);

      await vi.waitFor(() => {
        expect(logger.debug).toHaveBeenCalledWith(
          "Auto-start watcher check failed (non-fatal)",
          expect.objectContaining({ error: "Qdrant unreachable" }),
        );
      });

      expect(isWatching(TEST_PROJECT)).toBe(false);
    });

    it("caches external watch and skips retry within TTL", async () => {
      // Simulate another process holding the watch lock
      mockAcquireProjectLock.mockResolvedValue(false);
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 100 });
      mockGetProjectMetadata.mockResolvedValue({ indexingStatus: "completed" });

      ensureWatcherStarted(TEST_PROJECT);

      // Wait for the async chain to complete and cache the external watch
      await vi.waitFor(() => {
        expect(mockAcquireProjectLock).toHaveBeenCalled();
      });
      await new Promise((r) => setTimeout(r, 50));

      // Clear mocks to track subsequent calls
      mockGetCollectionInfo.mockClear();
      mockAcquireProjectLock.mockClear();

      // Call again — should be cached, no collection check or lock attempt
      ensureWatcherStarted(TEST_PROJECT);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockGetCollectionInfo).not.toHaveBeenCalled();
    });

    it("does not log 'Auto-started' when another process holds the lock", async () => {
      mockAcquireProjectLock.mockResolvedValue(false);
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 100 });
      mockGetProjectMetadata.mockResolvedValue({ indexingStatus: "completed" });

      ensureWatcherStarted(TEST_PROJECT);

      await vi.waitFor(() => {
        expect(mockAcquireProjectLock).toHaveBeenCalled();
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should log that another process is watching, NOT that we auto-started
      expect(logger.info).toHaveBeenCalledWith(
        "Another process is already watching this project, skipping",
        expect.anything(),
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        "Auto-started file watcher on tool use",
        expect.anything(),
      );
    });

    it("re-checks conditions after async gap", async () => {
      mockGetCollectionInfo.mockResolvedValue({ pointsCount: 100 });
      mockGetProjectMetadata.mockResolvedValue({ indexingStatus: "completed" });

      // Start watching before ensureWatcherStarted's async chain completes
      await startWatching(TEST_PROJECT);

      const watcher = await import("@parcel/watcher");
      const subscribeCallCount = vi.mocked(watcher.default.subscribe).mock.calls.length;

      ensureWatcherStarted(TEST_PROJECT);

      // Wait for the async chain
      await new Promise((r) => setTimeout(r, 50));

      // subscribe should NOT have been called again (re-check detected already watching)
      expect(vi.mocked(watcher.default.subscribe).mock.calls.length).toBe(subscribeCallCount);
    });
  });

  // ── Graceful degradation ───────────────────────────────────────────────

  describe("graceful degradation on update failure", () => {
    it("logs error but keeps watcher running when update fails", async () => {
      vi.useFakeTimers();
      vi.mocked(shouldIgnore).mockReturnValue(false);
      mockUpdateProjectIndex.mockRejectedValueOnce(new Error("Something failed"));

      await startWatching(TEST_PROJECT);

      mockSubscribeCallback?.(null, [
        { path: path.join(RESOLVED_PROJECT, "file.ts"), type: "update" },
      ]);

      await vi.advanceTimersByTimeAsync(2100);

      expect(logger.error).toHaveBeenCalledWith(
        "Watch auto-update failed",
        expect.objectContaining({ error: "Something failed" }),
      );
      // Watcher should still be running
      expect(isWatching(TEST_PROJECT)).toBe(true);
      vi.useRealTimers();
    });
  });
});

describe("watcher isIndexableFile — extensionless", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-watch-extless-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("treats a detected extensionless script as indexable", async () => {
    const p = path.join(dir, "strato-check-x");
    fs.writeFileSync(p, "#!/bin/bash\nexit 0\n");
    expect(await isIndexableFile(p)).toBe(true);
  });

  it("ignores a readable non-code extensionless file", async () => {
    const p = path.join(dir, "LICENSE");
    fs.writeFileSync(p, "MIT License\n\nCopyright (c) 2026\n");
    expect(await isIndexableFile(p)).toBe(false);
  });

  it("schedules (returns true) for a vanished extensionless file, to reconcile a delete", async () => {
    expect(await isIndexableFile(path.join(dir, "was-deleted"))).toBe(true);
  });

  it("ignores an extensionless directory (never head-reads it)", async () => {
    const d = path.join(dir, "somedir");
    fs.mkdirSync(d);
    expect(await isIndexableFile(d)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("ignores an extensionless FIFO without blocking on the open", async () => {
    // A FIFO reaches this guard like a directory does, but opening it for read
    // blocks until a writer appears — so the guard must lstat and drop it rather
    // than head-read it inside the long-lived watch callback (a directory throws
    // EISDIR; a FIFO would hang and starve the I/O threadpool).
    const fifo = path.join(dir, "evt-pipe");
    execFileSync("mkfifo", [fifo]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        isIndexableFile(fifo),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("blocked on FIFO open")), 2000);
        }),
      ]);
      expect(result).toBe(false);
    } finally {
      clearTimeout(timer);
      // Release any read-open a buggy guard left blocked so the leaked threadpool
      // op does not stall worker teardown.
      try {
        fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch {
        /* no blocked reader (guard worked) → ENXIO; ignore */
      }
    }
  });

  it("keeps supported extensions indexable without a read", async () => {
    expect(await isIndexableFile(path.join(dir, "a.ts"))).toBe(true);
  });

  it("respects the kill-switch for extensionless files", async () => {
    const p = path.join(dir, "probe");
    fs.writeFileSync(p, "#!/bin/bash\n");
    vi.stubEnv("INDEX_EXTENSIONLESS", "false");
    expect(await isIndexableFile(p)).toBe(false);
  });
});
