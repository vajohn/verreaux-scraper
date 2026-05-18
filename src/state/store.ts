import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  CookieRecord,
  RunState,
  RunStatus,
  ChapterStatus,
  PageStatus,
  ImageHash,
} from "../core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Row shapes (SQLite snake_case → TS camelCase mappings handled in each fn)
// ---------------------------------------------------------------------------

interface RunRow {
  run_id: string;
  series_url: string;
  series_id: string | null;
  series_title: string | null;
  source: string | null;
  source_domain: string | null;
  series_post_id: string | null;
  args_json: string;
  state: string;
  zip_path: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  exit_code: number | null;
  validated: number;
  rl_budget: number;
}

interface ChapterRow {
  run_id: string;
  chapter_number: number;
  chapter_url: string;
  chapter_title: string | null;
  selected: number;
  state: string;
  attempts: number;
  cf_attempts: number;
  verified: number;
  error_code: string | null;
  error_reason: string | null;
  expected_page_count: number | null;
}

interface PageRow {
  run_id: string;
  chapter_number: number;
  page_index: number;
  image_url: string;
  referer: string;
  sha1: string | null;
  bytes: number | null;
  ext: string | null;
  tmp_path: string | null;
  state: string;
  attempts: number;
  error_code: string | null;
  error_reason: string | null;
}

interface CookieRow {
  host: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null;
  user_agent: string;
  fetched_at: string;
  last_used: string | null;
  stale: number;
}

interface ImageHashRow {
  sha1: string;
  byte_length: number;
  mime: string;
  first_seen_at: string;
}

// ---------------------------------------------------------------------------
// Patch types for partial updates
// ---------------------------------------------------------------------------

export type RunPatch = Partial<
  Pick<
    RunState,
    | "status"
    | "seriesId"
    | "seriesTitle"
    | "sourceId"
    | "sourceDomain"
    | "seriesPostId"
    | "zipPath"
    | "finishedAt"
    | "exitCode"
    | "validated"
    | "rlBudget"
  >
>;

export type ChapterPatch = {
  state?: ChapterStatus;
  attempts?: number;
  cfAttempts?: number;
  verified?: boolean;
  errorCode?: string | null;
  errorReason?: string | null;
  expectedPageCount?: number | null;
  chapterUrl?: string;
};

export type PagePatch = {
  state?: PageStatus;
  sha1?: string | null;
  bytes?: number | null;
  ext?: string | null;
  tmpPath?: string | null;
  attempts?: number;
  errorCode?: string | null;
  errorReason?: string | null;
};

// ---------------------------------------------------------------------------
// Chapter input for upsert
// ---------------------------------------------------------------------------

export interface ChapterInput {
  runId: string;
  chapterNumber: number;
  chapterUrl: string;
  chapterTitle?: string | null;
  selected?: boolean;
  state?: ChapterStatus;
  expectedPageCount?: number | null;
}

// ---------------------------------------------------------------------------
// Page input for upsert
// ---------------------------------------------------------------------------

export interface PageInput {
  runId: string;
  chapterNumber: number;
  pageIndex: number;
  imageUrl: string;
  referer: string;
  state?: PageStatus;
}

// ---------------------------------------------------------------------------
// Row → domain type mappers
// ---------------------------------------------------------------------------

function rowToRun(row: RunRow): RunState {
  return {
    id: row.run_id,
    seriesUrl: row.series_url,
    sourceId: row.source,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    sourceDomain: row.source_domain,
    seriesPostId: row.series_post_id,
    argsJson: row.args_json,
    status: row.state as RunStatus,
    zipPath: row.zip_path,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    validated: row.validated === 1,
    rlBudget: row.rl_budget,
  };
}

function rowToCookie(row: CookieRow): CookieRecord {
  return {
    domain: row.domain,
    name: row.name,
    value: row.value,
    path: row.path,
    expires: row.expires,
    secure: false,
    httpOnly: false,
    sameSite: null,
    userAgent: row.user_agent,
    harvestedAt: row.fetched_at,
    lastUsedAt: row.last_used,
  };
}

function rowToImageHash(row: ImageHashRow): ImageHash {
  return {
    sha1: row.sha1,
    byteLength: row.byte_length,
    mime: row.mime,
    firstSeenAt: row.first_seen_at,
  };
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface Store {
  cookies: {
    upsert(rec: CookieRecord & { host: string; stale?: boolean }): void;
    findFresh(domain: string, maxAgeMs: number): CookieRecord[];
    delete(domain: string): void;
  };
  runs: {
    create(state: Omit<RunState, "updatedAt">): void;
    update(id: string, patch: RunPatch): void;
    get(id: string): RunState | undefined;
    findResumable(seriesUrl: string): RunState | undefined;
  };
  chapters: {
    upsert(input: ChapterInput): void;
    byRun(runId: string): ChapterRow[];
    markStatus(runId: string, chapterNumber: number, status: ChapterStatus, patch?: ChapterPatch): void;
  };
  pages: {
    upsert(input: PageInput): void;
    byChapter(runId: string, chapterNumber: number): PageRow[];
    markStatus(runId: string, chapterNumber: number, pageIndex: number, status: PageStatus, patch?: PagePatch): void;
  };
  hashes: {
    has(sha1: string): boolean;
    put(hash: ImageHash): void;
  };
  close(): void;
}

// ---------------------------------------------------------------------------
// openStore — opens DB, enables WAL, applies schema
// ---------------------------------------------------------------------------

export function openStore(path: string): Store {
  const db = new Database(path);

  // WAL mode is required for concurrent reads while a long-running scrape writes (A13).
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = join(__dirname, "schema.sql");
  const rawSql = readFileSync(schemaPath, "utf8");

  // Strip single-line SQL comments before splitting on ";", otherwise comment
  // text containing keywords can produce spurious empty/invalid statements.
  const schemaSql = rawSql
    .split("\n")
    .map((line) => {
      const commentIdx = line.indexOf("--");
      return commentIdx === -1 ? line : line.slice(0, commentIdx);
    })
    .join("\n");

  // Apply schema statements individually, skipping PRAGMA lines already
  // executed above (better-sqlite3 does not reliably execute multi-statement
  // strings containing PRAGMAs via exec on all versions).
  const statements = schemaSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.toUpperCase().startsWith("PRAGMA"));

  for (const stmt of statements) {
    db.exec(stmt + ";");
  }

  // ---------------------------------------------------------------------------
  // Prepared statements
  // ---------------------------------------------------------------------------

  const stmts = {
    cookieUpsert: db.prepare(`
      INSERT INTO cookies (host, name, value, domain, path, expires, user_agent, fetched_at, last_used, stale)
      VALUES (@host, @name, @value, @domain, @path, @expires, @user_agent, @fetched_at, @last_used, @stale)
      ON CONFLICT (host, name) DO UPDATE SET
        value      = excluded.value,
        expires    = excluded.expires,
        user_agent = excluded.user_agent,
        fetched_at = excluded.fetched_at,
        last_used  = excluded.last_used,
        stale      = excluded.stale
    `),

    cookieFindFresh: db.prepare<[string, string], CookieRow>(`
      SELECT * FROM cookies
      WHERE domain = ?
        AND stale = 0
        AND fetched_at >= ?
    `),

    cookieDelete: db.prepare(`DELETE FROM cookies WHERE domain = ?`),

    runInsert: db.prepare(`
      INSERT INTO runs (
        run_id, series_url, series_id, series_title, source, source_domain,
        series_post_id, args_json, state, zip_path, started_at, updated_at,
        finished_at, exit_code, validated, rl_budget
      ) VALUES (
        @run_id, @series_url, @series_id, @series_title, @source, @source_domain,
        @series_post_id, @args_json, @state, @zip_path, @started_at, @updated_at,
        @finished_at, @exit_code, @validated, @rl_budget
      )
    `),

    runSelectById: db.prepare<[string], RunRow>(`SELECT * FROM runs WHERE run_id = ?`),

    runFindResumable: db.prepare<[string], RunRow>(`
      SELECT * FROM runs
      WHERE series_url = ?
        AND state NOT IN ('DONE', 'DONE_PARTIAL', 'FATAL_CONFIG', 'FATAL_EMPTY_RANGE')
      ORDER BY started_at DESC
      LIMIT 1
    `),

    chapterUpsert: db.prepare(`
      INSERT INTO chapters (
        run_id, chapter_number, chapter_url, chapter_title, selected,
        state, expected_page_count
      ) VALUES (
        @run_id, @chapter_number, @chapter_url, @chapter_title, @selected,
        @state, @expected_page_count
      )
      ON CONFLICT (run_id, chapter_number) DO UPDATE SET
        chapter_url          = excluded.chapter_url,
        chapter_title        = excluded.chapter_title,
        selected             = excluded.selected,
        -- Preserve terminal DONE state on resume; otherwise reset to the
        -- caller-supplied state (typically PENDING during re-enumeration).
        state                = CASE WHEN chapters.state = 'DONE' THEN 'DONE' ELSE excluded.state END,
        expected_page_count  = COALESCE(excluded.expected_page_count, chapters.expected_page_count)
    `),

    chaptersByRun: db.prepare<[string], ChapterRow>(`
      SELECT * FROM chapters WHERE run_id = ? ORDER BY chapter_number ASC
    `),

    pageUpsert: db.prepare(`
      INSERT INTO pages (run_id, chapter_number, page_index, image_url, referer, state)
      VALUES (@run_id, @chapter_number, @page_index, @image_url, @referer, @state)
      ON CONFLICT (run_id, chapter_number, page_index) DO UPDATE SET
        image_url = excluded.image_url,
        referer   = excluded.referer,
        -- Preserve terminal DONE state on resume so successfully-downloaded
        -- pages aren't re-fetched when the chapter is rerun.
        state     = CASE WHEN pages.state = 'DONE' THEN 'DONE' ELSE excluded.state END
    `),

    pagesByChapter: db.prepare<[string, number], PageRow>(`
      SELECT * FROM pages
      WHERE run_id = ? AND chapter_number = ?
      ORDER BY page_index ASC
    `),

    hashExists: db.prepare<[string], { cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM image_hashes WHERE sha1 = ?
    `),

    hashInsert: db.prepare(`
      INSERT OR IGNORE INTO image_hashes (sha1, byte_length, mime, first_seen_at)
      VALUES (@sha1, @byte_length, @mime, @first_seen_at)
    `),
  };

  // ---------------------------------------------------------------------------
  // Dynamic update builders (used for partial patching)
  // ---------------------------------------------------------------------------

  function buildRunUpdate(id: string, patch: RunPatch): void {
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = { run_id: id, updated_at: now };

    if (patch.status !== undefined) { sets.push("state = @state"); params["state"] = patch.status; }
    if (patch.seriesId !== undefined) { sets.push("series_id = @series_id"); params["series_id"] = patch.seriesId; }
    if (patch.seriesTitle !== undefined) { sets.push("series_title = @series_title"); params["series_title"] = patch.seriesTitle; }
    if (patch.sourceId !== undefined) { sets.push("source = @source"); params["source"] = patch.sourceId; }
    if (patch.sourceDomain !== undefined) { sets.push("source_domain = @source_domain"); params["source_domain"] = patch.sourceDomain; }
    if (patch.seriesPostId !== undefined) { sets.push("series_post_id = @series_post_id"); params["series_post_id"] = patch.seriesPostId; }
    if (patch.zipPath !== undefined) { sets.push("zip_path = @zip_path"); params["zip_path"] = patch.zipPath; }
    if (patch.finishedAt !== undefined) { sets.push("finished_at = @finished_at"); params["finished_at"] = patch.finishedAt; }
    if (patch.exitCode !== undefined) { sets.push("exit_code = @exit_code"); params["exit_code"] = patch.exitCode; }
    if (patch.validated !== undefined) { sets.push("validated = @validated"); params["validated"] = patch.validated ? 1 : 0; }
    if (patch.rlBudget !== undefined) { sets.push("rl_budget = @rl_budget"); params["rl_budget"] = patch.rlBudget; }

    db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = @run_id`).run(params);
  }

  function buildChapterUpdate(
    runId: string,
    chapterNumber: number,
    patch: ChapterPatch,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { run_id: runId, chapter_number: chapterNumber };

    if (patch.state !== undefined) { sets.push("state = @state"); params["state"] = patch.state; }
    if (patch.attempts !== undefined) { sets.push("attempts = @attempts"); params["attempts"] = patch.attempts; }
    if (patch.cfAttempts !== undefined) { sets.push("cf_attempts = @cf_attempts"); params["cf_attempts"] = patch.cfAttempts; }
    if (patch.verified !== undefined) { sets.push("verified = @verified"); params["verified"] = patch.verified ? 1 : 0; }
    if (patch.errorCode !== undefined) { sets.push("error_code = @error_code"); params["error_code"] = patch.errorCode; }
    if (patch.errorReason !== undefined) { sets.push("error_reason = @error_reason"); params["error_reason"] = patch.errorReason; }
    if (patch.expectedPageCount !== undefined) { sets.push("expected_page_count = @expected_page_count"); params["expected_page_count"] = patch.expectedPageCount; }
    if (patch.chapterUrl !== undefined) { sets.push("chapter_url = @chapter_url"); params["chapter_url"] = patch.chapterUrl; }

    if (sets.length === 0) return;

    db.prepare(
      `UPDATE chapters SET ${sets.join(", ")} WHERE run_id = @run_id AND chapter_number = @chapter_number`,
    ).run(params);
  }

  function buildPageUpdate(
    runId: string,
    chapterNumber: number,
    pageIndex: number,
    patch: PagePatch,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = {
      run_id: runId,
      chapter_number: chapterNumber,
      page_index: pageIndex,
    };

    if (patch.state !== undefined) { sets.push("state = @state"); params["state"] = patch.state; }
    if (patch.sha1 !== undefined) { sets.push("sha1 = @sha1"); params["sha1"] = patch.sha1; }
    if (patch.bytes !== undefined) { sets.push("bytes = @bytes"); params["bytes"] = patch.bytes; }
    if (patch.ext !== undefined) { sets.push("ext = @ext"); params["ext"] = patch.ext; }
    if (patch.tmpPath !== undefined) { sets.push("tmp_path = @tmp_path"); params["tmp_path"] = patch.tmpPath; }
    if (patch.attempts !== undefined) { sets.push("attempts = @attempts"); params["attempts"] = patch.attempts; }
    if (patch.errorCode !== undefined) { sets.push("error_code = @error_code"); params["error_code"] = patch.errorCode; }
    if (patch.errorReason !== undefined) { sets.push("error_reason = @error_reason"); params["error_reason"] = patch.errorReason; }

    if (sets.length === 0) return;

    db.prepare(
      `UPDATE pages SET ${sets.join(", ")} WHERE run_id = @run_id AND chapter_number = @chapter_number AND page_index = @page_index`,
    ).run(params);
  }

  // ---------------------------------------------------------------------------
  // Store implementation
  // ---------------------------------------------------------------------------

  return {
    cookies: {
      upsert(rec) {
        stmts.cookieUpsert.run({
          host: rec.domain,
          name: rec.name,
          value: rec.value,
          domain: rec.domain,
          path: rec.path,
          expires: rec.expires,
          user_agent: rec.userAgent,
          fetched_at: rec.harvestedAt,
          last_used: rec.lastUsedAt,
          stale: 0,
        });
      },

      findFresh(domain, maxAgeMs) {
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        return stmts.cookieFindFresh.all(domain, cutoff).map(rowToCookie);
      },

      delete(domain) {
        stmts.cookieDelete.run(domain);
      },
    },

    runs: {
      create(state) {
        stmts.runInsert.run({
          run_id: state.id,
          series_url: state.seriesUrl,
          series_id: state.seriesId,
          series_title: state.seriesTitle,
          source: state.sourceId,
          source_domain: state.sourceDomain,
          series_post_id: state.seriesPostId,
          args_json: state.argsJson,
          state: state.status,
          zip_path: state.zipPath,
          started_at: state.startedAt,
          updated_at: new Date().toISOString(),
          finished_at: state.finishedAt,
          exit_code: state.exitCode,
          validated: state.validated ? 1 : 0,
          rl_budget: state.rlBudget,
        });
      },

      update(id, patch) {
        buildRunUpdate(id, patch);
      },

      get(id) {
        const row = stmts.runSelectById.get(id);
        return row ? rowToRun(row) : undefined;
      },

      findResumable(seriesUrl) {
        const row = stmts.runFindResumable.get(seriesUrl);
        return row ? rowToRun(row) : undefined;
      },
    },

    chapters: {
      upsert(input) {
        stmts.chapterUpsert.run({
          run_id: input.runId,
          chapter_number: input.chapterNumber,
          chapter_url: input.chapterUrl,
          chapter_title: input.chapterTitle ?? null,
          selected: input.selected ? 1 : 0,
          state: input.state ?? "PENDING",
          expected_page_count: input.expectedPageCount ?? null,
        });
      },

      byRun(runId) {
        return stmts.chaptersByRun.all(runId);
      },

      markStatus(runId, chapterNumber, status, patch) {
        buildChapterUpdate(runId, chapterNumber, { state: status, ...patch });
      },
    },

    pages: {
      upsert(input) {
        stmts.pageUpsert.run({
          run_id: input.runId,
          chapter_number: input.chapterNumber,
          page_index: input.pageIndex,
          image_url: input.imageUrl,
          referer: input.referer,
          state: input.state ?? "PENDING",
        });
      },

      byChapter(runId, chapterNumber) {
        return stmts.pagesByChapter.all(runId, chapterNumber);
      },

      markStatus(runId, chapterNumber, pageIndex, status, patch) {
        buildPageUpdate(runId, chapterNumber, pageIndex, { state: status, ...patch });
      },
    },

    hashes: {
      has(sha1) {
        const row = stmts.hashExists.get(sha1);
        return (row?.cnt ?? 0) > 0;
      },

      put(hash) {
        stmts.hashInsert.run({
          sha1: hash.sha1,
          byte_length: hash.byteLength,
          mime: hash.mime,
          first_seen_at: hash.firstSeenAt,
        });
      },
    },

    close() {
      db.close();
    },
  };
}
