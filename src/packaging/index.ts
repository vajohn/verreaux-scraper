/**
 * Barrel export for the packaging module.
 */
export {
  sanitizeSeriesName,
  formatChapterFolder,
  formatPageFilename,
  pickCoverFilename,
} from "./sanitize.js";

export {
  StagingDir,
  detectImageExt,
  UnsupportedImageFormatError,
} from "./staging.js";

export {
  Packager,
  PackageIncompletenessError,
} from "./packager.js";

export type { PackagerBuildOpts, PackagerBuildResult } from "./packager.js";
