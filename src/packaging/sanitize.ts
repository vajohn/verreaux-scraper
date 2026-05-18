/**
 * Filesystem-safe naming helpers for the ZIP packager.
 *
 * All constraints derived from §1 of workflow.md and verified against
 * app/src/features/import/zipWalker.ts + app/src/lib/naturalSort.ts.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Characters illegal on Windows (and generally undesirable in ZIP paths). */
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|]/g;

/** Collapse runs of spaces to a single space. */
const MULTI_SPACE_RE = / {2,}/g;

// ---------------------------------------------------------------------------
// sanitizeSeriesName
// ---------------------------------------------------------------------------

/**
 * Returns a filesystem-safe series folder name.
 *
 * Rules (§1):
 * - Replace `\/:*?"<>|` with `_`
 * - Collapse multiple spaces to one
 * - Trim leading/trailing whitespace
 * - Strip trailing dot (Windows quirk: `dir.` and `dir` are the same)
 * - Truncate to ≤200 characters (no hashing — just hard cut)
 */
export function sanitizeSeriesName(raw: string): string {
  let s = raw
    .replace(ILLEGAL_CHARS_RE, "_")
    .replace(MULTI_SPACE_RE, " ")
    .trim();

  // Remove trailing dot(s) after trim — re-trim in case that exposed whitespace
  s = s.replace(/\.+$/, "").trim();

  return s.slice(0, 200);
}

// ---------------------------------------------------------------------------
// formatChapterFolder
// ---------------------------------------------------------------------------

/**
 * Canonical list of prefixes that indicate a title is just a chapter
 * number restatement and carries no meaningful additional information.
 * We strip these so we don't get "Chapter 001: Chapter 1" redundancy.
 *
 * Patterns matched (case-insensitive):
 *   "Chapter N", "Chapter N.5", "Ch N", "Ch. N", "Ch.N", "Chapter N:"
 */
const CHAPTER_RESTATEMENT_RE =
  /^\s*(?:chapter|ch\.?)\s*\d+(?:\.\d+)?\s*:?\s*$/i;

/**
 * Zero-pad the integer part of a chapter number to at least `width` digits.
 * Preserves the decimal part (e.g. "1.5" → "001.5" at width 3).
 */
function padChapterNumber(order: number, width: number): string {
  const intPart = Math.floor(order);
  const frac = order - intPart;

  const padded = String(intPart).padStart(width, "0");

  if (frac > 0) {
    // Represent the fractional portion. Use the minimal decimal representation
    // but strip the leading "0" so "0.5" becomes ".5" → combined: "001.5".
    const fracStr = frac.toFixed(10).slice(1).replace(/0+$/, "");
    return padded + fracStr;
  }
  return padded;
}

/**
 * Produces the chapter sub-folder name, e.g.:
 *   formatChapterFolder(1)                    → "Chapter 001"
 *   formatChapterFolder(1.5)                  → "Chapter 001.5"
 *   formatChapterFolder(12, "Tower of Blood") → "Chapter 012: Tower of Blood"
 *   formatChapterFolder(12, "Chapter 12")     → "Chapter 012"  (no redundancy)
 *
 * Zero-padding width (§1 constraint 3):
 *   ≥3 digits always; caller passes `padWidth` when any chapter in the run is
 *   ≥1000 (requiring 4 digits). Default 3.
 *
 * Sortability: `extractSortKey("Chapter 001")` → 1, which equals `order`.
 * The PWA's `walkSeries` sorts chapter folders via `extractSortKey`, so the
 * numeric prefix MUST match the intended sort key.
 */
export function formatChapterFolder(
  order: number,
  title?: string,
  padWidth = 3,
): string {
  const numStr = padChapterNumber(order, padWidth);
  const base = `Chapter ${numStr}`;

  if (title == null || title.trim() === "") {
    return base;
  }

  const sanitized = sanitizeSeriesName(title); // reuse same rules for inner title
  if (sanitized === "" || CHAPTER_RESTATEMENT_RE.test(sanitized)) {
    return base;
  }

  return `${base}: ${sanitized}`;
}

// ---------------------------------------------------------------------------
// formatPageFilename
// ---------------------------------------------------------------------------

/**
 * Produces the page filename, e.g.:
 *   formatPageFilename(1,  ".png")  → "001.png"
 *   formatPageFilename(42, ".webp") → "042.webp"
 *
 * Zero-padding width: 3 digits minimum; caller passes `padWidth=4` when the
 * chapter has ≥1000 pages (defensive).
 *
 * `extractSortKey("042")` → 42, which equals `pageNumber`. Ordering is
 * preserved for the importer.
 */
export function formatPageFilename(
  pageNumber: number,
  ext: string,
  padWidth = 3,
): string {
  const padded = String(pageNumber).padStart(padWidth, "0");
  // Normalise ext: ensure leading dot, lowercase
  const normExt = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();
  return `${padded}${normExt}`;
}

// ---------------------------------------------------------------------------
// pickCoverFilename
// ---------------------------------------------------------------------------

/** MIME type → cover filename. Must match `/^cover\.(webp|jpg|jpeg|png)$/i`. */
export function pickCoverFilename(
  mime: string,
): "cover.webp" | "cover.jpg" | "cover.jpeg" | "cover.png" {
  const m = mime.toLowerCase();
  if (m.includes("webp")) return "cover.webp";
  if (m.includes("jpeg")) return "cover.jpeg";
  if (m.includes("jpg")) return "cover.jpg";
  if (m.includes("png")) return "cover.png";
  // Unknown mime — default to png (lossless, universally accepted)
  return "cover.png";
}
