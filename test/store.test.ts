import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { openStore } from "../src/state/store.js";
import type { Store } from "../src/state/store.js";
import type { CookieRecord, RunState, ImageHash } from "../src/core/types.js";
import { makeTmpDir } from "./setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<RunState> = {}): Omit<RunState, "updatedAt"> {
  const now = new Date().toISOString();
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    seriesUrl: "https://asuracomic.net/series/test-series-abc123",
    sourceId: "asurascans",
    seriesId: null,
    seriesTitle: null,
    sourceDomain: "asuracomic.net",
    seriesPostId: null,
    argsJson: JSON.stringify({ from: 1, to: "latest" }),
    status: "INIT",
    zipPath: null,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    validated: false,
    rlBudget: 6,
    ...overrides,
  };
}

function makeCookie(overrides: Partial<CookieRecord & { host: string }> = {}): CookieRecord & { host: string } {
  return {
    host: "asuracomic.net",
    domain: "asuracomic.net",
    name: "cf_clearance",
    value: "test-clearance-value",
    path: "/",
    expires: null,
    secure: true,
    httpOnly: false,
    sameSite: null,
    userAgent: "Mozilla/5.0 (test)",
    harvestedAt: new Date().toISOString(),
    lastUsedAt: null,
    ...overrides,
  };
}

function makeImageHash(overrides: Partial<ImageHash> = {}): ImageHash {
  return {
    sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    byteLength: 184221,
    mime: "image/webp",
    firstSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("store", () => {
  let dir: string;
  let cleanup: () => void;
  let store: Store;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    store = openStore(join(dir, "state.sqlite"));
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Schema application
  // -------------------------------------------------------------------------

  describe("schema", () => {
    it("applies cleanly on a fresh database without errors", () => {
      // If schema fails, openStore throws — reaching here means it succeeded.
      expect(store).toBeDefined();
    });

    it("is idempotent — opening the same path twice does not throw", () => {
      const dbPath = join(dir, "state.sqlite");
      store.close();

      const store1 = openStore(dbPath);
      store1.close();

      // Second open re-runs CREATE TABLE IF NOT EXISTS — must not throw.
      const store2 = openStore(dbPath);
      store2.close();

      // Re-open for afterEach cleanup
      store = openStore(dbPath);
    });

    it("creates all expected tables", () => {
      // Verify by performing a no-op read on each table. If the table is
      // absent better-sqlite3 throws with "no such table".
      const runRow = store.runs.get("nonexistent");
      expect(runRow).toBeUndefined();

      const cookies = store.cookies.findFresh("example.com", 60_000);
      expect(cookies).toEqual([]);

      const hashes = store.hashes.has("nonexistent");
      expect(hashes).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cookie freshness filter (§7 CF_CHECK_JAR: fresh < 25 min → A9)
  // -------------------------------------------------------------------------

  describe("cookies", () => {
    const TWENTY_FIVE_MINUTES_MS = 25 * 60 * 1000;

    it("findFresh returns a cookie harvested within the window", () => {
      store.cookies.upsert(makeCookie());
      const results = store.cookies.findFresh("asuracomic.net", TWENTY_FIVE_MINUTES_MS);
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("cf_clearance");
    });

    it("findFresh excludes a cookie older than the window", () => {
      // harvestedAt 30 minutes ago — outside the 25-minute window.
      const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      store.cookies.upsert(makeCookie({ harvestedAt: oldTs }));
      const results = store.cookies.findFresh("asuracomic.net", TWENTY_FIVE_MINUTES_MS);
      expect(results).toHaveLength(0);
    });

    it("findFresh excludes cookies for a different domain", () => {
      store.cookies.upsert(makeCookie({ domain: "manhuaplus.org", host: "manhuaplus.org" }));
      const results = store.cookies.findFresh("asuracomic.net", TWENTY_FIVE_MINUTES_MS);
      expect(results).toHaveLength(0);
    });

    it("upsert updates an existing cookie on conflict", () => {
      store.cookies.upsert(makeCookie({ value: "first-value" }));
      store.cookies.upsert(makeCookie({ value: "updated-value" }));
      const results = store.cookies.findFresh("asuracomic.net", TWENTY_FIVE_MINUTES_MS);
      expect(results).toHaveLength(1);
      expect(results[0]?.value).toBe("updated-value");
    });

    it("delete removes all cookies for a domain", () => {
      store.cookies.upsert(makeCookie());
      store.cookies.delete("asuracomic.net");
      const results = store.cookies.findFresh("asuracomic.net", TWENTY_FIVE_MINUTES_MS);
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Run resumability
  // -------------------------------------------------------------------------

  describe("runs", () => {
    it("create + get round-trips a run record", () => {
      const run = makeRunState({ id: "run-test-1" });
      store.runs.create(run);
      const fetched = store.runs.get("run-test-1");
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe("run-test-1");
      expect(fetched?.seriesUrl).toBe(run.seriesUrl);
      expect(fetched?.status).toBe("INIT");
    });

    it("findResumable returns the most recent non-terminal run for a seriesUrl", () => {
      const url = "https://asuracomic.net/series/solo-leveling-abc";
      const older = makeRunState({
        id: "run-old",
        seriesUrl: url,
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        status: "DOWNLOAD_CHAPTERS",
      });
      const newer = makeRunState({
        id: "run-new",
        seriesUrl: url,
        startedAt: new Date().toISOString(),
        status: "ENUMERATE_CHAPTERS",
      });

      store.runs.create(older);
      store.runs.create(newer);

      const found = store.runs.findResumable(url);
      expect(found?.id).toBe("run-new");
    });

    it("findResumable ignores DONE runs", () => {
      const url = "https://asuracomic.net/series/completed-series";
      store.runs.create(makeRunState({ id: "run-done", seriesUrl: url, status: "DONE" }));
      const found = store.runs.findResumable(url);
      expect(found).toBeUndefined();
    });

    it("findResumable ignores FATAL_CONFIG runs", () => {
      const url = "https://asuracomic.net/series/bad-config";
      store.runs.create(makeRunState({ id: "run-fatal", seriesUrl: url, status: "FATAL_CONFIG" }));
      const found = store.runs.findResumable(url);
      expect(found).toBeUndefined();
    });

    it("update patches individual fields without overwriting others", () => {
      const run = makeRunState({ id: "run-patch" });
      store.runs.create(run);

      store.runs.update("run-patch", { status: "RESOLVE_SERIES", seriesTitle: "Test Series" });

      const fetched = store.runs.get("run-patch");
      expect(fetched?.status).toBe("RESOLVE_SERIES");
      expect(fetched?.seriesTitle).toBe("Test Series");
      // Fields not in patch must survive
      expect(fetched?.seriesUrl).toBe(run.seriesUrl);
      expect(fetched?.rlBudget).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // Chapter operations
  // -------------------------------------------------------------------------

  describe("chapters", () => {
    it("upsert + byRun round-trips chapter records", () => {
      const run = makeRunState({ id: "run-ch1" });
      store.runs.create(run);

      store.chapters.upsert({
        runId: "run-ch1",
        chapterNumber: 1,
        chapterUrl: "https://asuracomic.net/series/test/chapter-1",
        selected: true,
      });

      const rows = store.chapters.byRun("run-ch1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.chapter_number).toBe(1);
      expect(rows[0]?.selected).toBe(1);
    });

    it("markStatus updates chapter state", () => {
      store.runs.create(makeRunState({ id: "run-ch2" }));
      store.chapters.upsert({
        runId: "run-ch2",
        chapterNumber: 5,
        chapterUrl: "https://asuracomic.net/series/test/chapter-5",
      });

      store.chapters.markStatus("run-ch2", 5, "DONE", { verified: true });

      const rows = store.chapters.byRun("run-ch2");
      expect(rows[0]?.state).toBe("DONE");
      expect(rows[0]?.verified).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Page operations
  // -------------------------------------------------------------------------

  describe("pages", () => {
    it("upsert + byChapter round-trips page records", () => {
      store.runs.create(makeRunState({ id: "run-pg1" }));
      store.chapters.upsert({
        runId: "run-pg1",
        chapterNumber: 1,
        chapterUrl: "https://example.com/ch1",
      });

      store.pages.upsert({
        runId: "run-pg1",
        chapterNumber: 1,
        pageIndex: 1,
        imageUrl: "https://gg.asuracomic.net/ch1/001.webp",
        referer: "https://asuracomic.net/series/test/chapter-1",
      });

      const rows = store.pages.byChapter("run-pg1", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.page_index).toBe(1);
      expect(rows[0]?.state).toBe("PENDING");
    });

    it("markStatus updates page state and sha1", () => {
      store.runs.create(makeRunState({ id: "run-pg2" }));
      store.chapters.upsert({
        runId: "run-pg2",
        chapterNumber: 1,
        chapterUrl: "https://example.com/ch1",
      });
      store.pages.upsert({
        runId: "run-pg2",
        chapterNumber: 1,
        pageIndex: 1,
        imageUrl: "https://gg.asuracomic.net/001.webp",
        referer: "https://example.com/ch1",
      });

      store.pages.markStatus("run-pg2", 1, 1, "DONE", {
        sha1: "deadbeef01deadbeef01deadbeef01deadbeef01",
        bytes: 184221,
        ext: ".webp",
      });

      const rows = store.pages.byChapter("run-pg2", 1);
      expect(rows[0]?.state).toBe("DONE");
      expect(rows[0]?.sha1).toBe("deadbeef01deadbeef01deadbeef01deadbeef01");
    });
  });

  // -------------------------------------------------------------------------
  // SHA-1 dedup cache (§8.4)
  // -------------------------------------------------------------------------

  describe("hashes", () => {
    it("has() returns false for an unknown sha1", () => {
      expect(store.hashes.has("0000000000000000000000000000000000000000")).toBe(false);
    });

    it("has() returns true after put()", () => {
      const hash = makeImageHash({ sha1: "aaaa0000000000000000000000000000aaaa0000" });
      store.hashes.put(hash);
      expect(store.hashes.has("aaaa0000000000000000000000000000aaaa0000")).toBe(true);
    });

    it("put() is idempotent — inserting the same sha1 twice does not throw", () => {
      const hash = makeImageHash({ sha1: "bbbb0000000000000000000000000000bbbb0000" });
      expect(() => {
        store.hashes.put(hash);
        store.hashes.put(hash);
      }).not.toThrow();
    });
  });
});
