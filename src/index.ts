// Public type surface for verreaux-scrape.
// Re-exports only — no runtime code here.

export type {
  ExitCode,
  ImgExt,
  ImageHash,
  CookieRecord,
  RunStatus,
  ChapterStatus,
  PageStatus,
  RunState,
  ChapterMeta,
  ChapterStub,
  PageMeta,
  PageStub,
  SeriesMeta,
  ResolvedSeries,
  AdapterContext,
  SourceAdapter,
  RunConfig,
  RunConfigInput,
  RunConfigParsed,
} from "./core/types.js";

export type { ScraperEvent, Envelope } from "./core/events.js";
export { EventBus, createPinoSink, attachPinoSink } from "./core/events.js";

export { runConfigSchema } from "./core/runConfigSchema.js";

export type { Store, RunPatch, ChapterPatch, PagePatch, ChapterInput, PageInput } from "./state/store.js";
export { openStore } from "./state/store.js";

// Transport layer — public types and implementations
export type { HttpClient, HttpClientOptions, RequestOptions, PostOptions } from "./transport/http.js";
export { createHttpClient } from "./transport/http.js";

export type { HarvestResult } from "./transport/browser.js";
export { BrowserPool, AbortError } from "./transport/browser.js";

export { CookieJar } from "./transport/cookies.js";

export { Throttler } from "./transport/throttle.js";

export type { CfRequest, CfResolveContext, CfSuccess, CfFailure, CfState } from "./transport/cf.js";
export { CfHandler, CfUnsolvableError } from "./transport/cf.js";

export { FlareSolverrClient } from "./transport/flaresolverr.js";

// Adapter registry
export { adapterRegistry, AsuraScansAdapter } from "./adapters/index.js";
export type { AdapterRegistry } from "./adapters/index.js";

// ManhuaPlus adapter — singleton and public error type
export { manhuaPlusAdapter, LilianaParseError } from "./adapters/manhuaplus.js";
export type { RawChapter, SeriesMetadata, ImageListResponse } from "./adapters/manhuaplus.helpers.js";

// Packaging module
export {
  sanitizeSeriesName,
  formatChapterFolder,
  formatPageFilename,
  pickCoverFilename,
  StagingDir,
  detectImageExt,
  UnsupportedImageFormatError,
  Packager,
  PackageIncompletenessError,
} from "./packaging/index.js";
export type { PackagerBuildOpts, PackagerBuildResult } from "./packaging/index.js";

// Pipeline
export { Pipeline } from "./core/pipeline.js";
export type { PipelineResult } from "./core/pipeline.js";
