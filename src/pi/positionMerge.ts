export interface Position {
  chapterOrder: number;
  pageIndex: number;
  manuallyMarked: boolean;
}

export interface StoredPosition extends Position {
  /** Device id that set the current value (drives the regression rule). */
  ownerDevice: string;
}

export interface MergeResult {
  changed: boolean;
  value: StoredPosition;
}

/** -1 / 0 / 1 comparing (chapterOrder, then pageIndex). */
function cmp(a: Position, b: Position): number {
  if (a.chapterOrder !== b.chapterOrder) return a.chapterOrder < b.chapterOrder ? -1 : 1;
  if (a.pageIndex !== b.pageIndex) return a.pageIndex < b.pageIndex ? -1 : 1;
  return 0;
}

/**
 * Furthest position wins; a deliberate regression is honored only from the
 * device that owns the current value.
 */
export function mergePosition(
  current: StoredPosition | null,
  incoming: Position & { device: string },
): MergeResult {
  const adopted: StoredPosition = {
    chapterOrder: incoming.chapterOrder,
    pageIndex: incoming.pageIndex,
    manuallyMarked: incoming.manuallyMarked,
    ownerDevice: incoming.device,
  };
  if (!current) return { changed: true, value: adopted };

  const c = cmp(incoming, current);
  if (c > 0) return { changed: true, value: adopted };
  if (c < 0 && incoming.device === current.ownerDevice) return { changed: true, value: adopted };
  return { changed: false, value: current };
}
