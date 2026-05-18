import type { ChapterMeta } from "./types.js";

export class EmptyRangeError extends Error {
  override readonly name = "EmptyRangeError";
  readonly code = "ERR_EMPTY_RANGE";
  constructor(from: number, to: number | "latest") {
    super(`Range [${from}, ${String(to)}] is empty (from > to).`);
  }
}

export class NoChaptersInRangeError extends Error {
  override readonly name = "NoChaptersInRangeError";
  readonly code = "ERR_NO_CHAPTERS_IN_RANGE";
  constructor(from: number, to: number | "latest") {
    super(`No chapters found in range [${from}, ${String(to)}].`);
  }
}

export function selectChapters(
  chapters: ChapterMeta[],
  from: number = 0,
  to: number | "latest" = "latest",
  explicitList: readonly number[] | null = null,
): ChapterMeta[] {
  // Explicit list takes precedence over from/to range.
  if (explicitList !== null) {
    const wanted = new Set(explicitList);
    const selected = chapters.filter((c) => wanted.has(c.number));

    if (selected.length === 0) {
      throw new NoChaptersInRangeError(
        Math.min(...explicitList),
        Math.max(...explicitList),
      );
    }

    return selected.slice().sort((a, b) => a.number - b.number);
  }

  const resolvedTo: number = to === "latest" ? Infinity : to;

  if (from > resolvedTo) {
    throw new EmptyRangeError(from, to);
  }

  const selected = chapters.filter(
    (c) => c.number >= from && c.number <= resolvedTo,
  );

  if (selected.length === 0) {
    throw new NoChaptersInRangeError(from, to);
  }

  return selected.slice().sort((a, b) => a.number - b.number);
}
