// ---------------------------------------------------------------------------
// qimanhwa.helpers.ts — pure helpers for qimanhwa.com (Angular SSR SPA).
//
// Each page embeds <script id="ng-state" type="application/json">{...}</script>
// (Angular TransferState) — PLAIN JSON, parse directly. It is a map of
// hash-key -> cached HTTP response { b: body, h, s, st, u: url, rt }. The SSR
// server populates it with the site's REST API responses, so the series meta,
// chapter list, and per-chapter image list are all present without any live
// API call. We locate entries by the request URL (`u`) suffix.
//
// Site origin: https://qimanhwa.com ; API host (in `u` values):
//   https://api.qimanhwa.com/api/v1
// Chapter image urls live on a media CDN (host varies, e.g.
// media.quantumscans.org) and are used verbatim.
// ---------------------------------------------------------------------------

const ORIGIN = "https://qimanhwa.com";

export class QimanhwaParseError extends Error {
  override readonly name = "QimanhwaParseError";
}

export interface QiSeriesMeta {
  title: string;
  coverUrl: string;
}

export interface RawQiChapter {
  slug: string;   // e.g. "chapter-178"
  number: number; // e.g. 178
  url: string;    // https://qimanhwa.com/series/<seriesSlug>/<slug>
}

/** Angular TransferState cache entry. */
interface NgCacheEntry {
  b: unknown; // response body
  u?: string; // request url
}
export type NgStateMap = Record<string, NgCacheEntry>;

// <script id="ng-state" type="application/json"> ... </script> — plain JSON.
const NG_STATE_RE = /<script id="ng-state" type="application\/json">([\s\S]*?)<\/script>/;

export function extractNgState(html: string): NgStateMap | null {
  const m = NG_STATE_RE.exec(html);
  if (!m || !m[1]) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return typeof parsed === "object" && parsed !== null ? (parsed as NgStateMap) : null;
  } catch {
    return null;
  }
}

/** Return the `b` (body) of the cached entry whose request url ends with `suffix`. */
export function findCachedBodyByUrlSuffix(state: NgStateMap, suffix: string): unknown {
  for (const key of Object.keys(state)) {
    const entry = state[key];
    if (entry && typeof entry === "object" && typeof entry.u === "string") {
      const path = entry.u.split("?")[0]!;
      if (path.endsWith(suffix)) return entry.b;
    }
  }
  return undefined;
}

export function mapSeriesMeta(state: NgStateMap, seriesSlug: string): QiSeriesMeta {
  const body = findCachedBodyByUrlSuffix(state, `/series/${seriesSlug}`) as
    | { title?: unknown; cover?: unknown }
    | undefined;
  if (!body || typeof body.title !== "string") {
    throw new QimanhwaParseError(
      `mapSeriesMeta: no series body for "${seriesSlug}" in ng-state`,
    );
  }
  return {
    title: body.title,
    coverUrl: typeof body.cover === "string" ? body.cover : "",
  };
}

interface ChapterListEntry {
  slug: string;
  number: number;
  isFree?: boolean;
  requiresPurchase?: boolean;
}

export function mapChapterList(
  state: NgStateMap,
  seriesSlug: string,
): { chapters: RawQiChapter[]; skippedLocked: number } {
  const body = findCachedBodyByUrlSuffix(state, `/series/${seriesSlug}/chapters`) as
    | { data?: unknown }
    | undefined;
  if (!body || !Array.isArray(body.data)) {
    throw new QimanhwaParseError(
      `mapChapterList: no chapters body for "${seriesSlug}" in ng-state`,
    );
  }

  const chapters: RawQiChapter[] = [];
  let skippedLocked = 0;
  for (const raw of body.data as ChapterListEntry[]) {
    if (typeof raw.slug !== "string" || typeof raw.number !== "number") continue;
    const locked = raw.isFree === false || raw.requiresPurchase === true;
    if (locked) {
      skippedLocked++;
      continue;
    }
    chapters.push({
      slug: raw.slug,
      number: raw.number,
      url: `${ORIGIN}/series/${seriesSlug}/${raw.slug}`,
    });
  }
  chapters.sort((a, b) => a.number - b.number);
  return { chapters, skippedLocked };
}

interface ChapterImage {
  url: string;
  order?: number;
}

export function mapChapterImages(
  state: NgStateMap,
  seriesSlug: string,
  chapterSlug: string,
): string[] {
  const body = findCachedBodyByUrlSuffix(
    state,
    `/series/${seriesSlug}/chapters/${chapterSlug}`,
  ) as { images?: unknown } | undefined;
  if (!body || !Array.isArray(body.images)) {
    throw new QimanhwaParseError(
      `mapChapterImages: no chapter body for "${seriesSlug}/${chapterSlug}" in ng-state`,
    );
  }
  const images = (body.images as ChapterImage[])
    .filter((i) => typeof i.url === "string")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((i) => i.url.trim());
  return images;
}
