// Global test setup. Runs before each test file via vitest.config.ts setupFiles.
// Intentionally minimal — store tests use in-memory or tmp-file DBs; no global
// fixtures are needed at this layer.

import { afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Expose a helper that creates a fresh temp directory per test file.
// Tests import this directly rather than relying on a global.
export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "verreaux-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Belt-and-suspenders: if anything registers a global tmp dir it gets cleaned.
const globalDirs: Array<() => void> = [];

export function registerTmpDir(cleanup: () => void): void {
  globalDirs.push(cleanup);
}

afterAll(() => {
  for (const cleanup of globalDirs) {
    cleanup();
  }
});
