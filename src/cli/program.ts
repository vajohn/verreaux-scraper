/**
 * program.ts — Commander wiring, argument parsing, validation, and top-level
 * orchestration.
 *
 * `runCli(argv)` is the single entry-point called by index.ts. It:
 *   1. Parses and validates all flags per §3.
 *   2. Resolves the adapter via adapterRegistry.
 *   3. Parses flags into RunConfig via RunConfigSchema.
 *   4. Builds the run context (store, transport, …).
 *   5. Installs signal handlers.
 *   6. Attaches the progress reporter.
 *   7. Runs the pipeline.
 *   8. Returns the exit code from PipelineResult (or maps thrown errors).
 */

import { Command } from "commander";
import { access, mkdir, constants } from "node:fs/promises";
import { resolve as resolvePath, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { runConfigSchema } from "../core/runConfigSchema.js";
import { buildRunContext } from "../core/runContext.js";
import { Pipeline } from "../core/pipeline.js";
import { adapterRegistry } from "../adapters/index.js";
import { createPinoSink } from "../core/events.js";
import { installSignalHandlers } from "./signals.js";
import { ProgressReporter } from "./progress.js";
import { mapErrorToExitCode } from "./errorMap.js";
import { ExitCode } from "../core/types.js";
import type { GroupInfo, RunConfig, SourceAdapter, AdapterContext } from "../core/types.js";

// ---------------------------------------------------------------------------
// Version — read from package.json at the dist root level.
// ---------------------------------------------------------------------------

function readVersion(): string {
  try {
    // Works in both ESM (import.meta.url) and CJS fallback paths.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Climb: dist/cli/ → dist/ → project root
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const req = createRequire(import.meta.url);
    const pkg = req(pkgPath) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

// ---------------------------------------------------------------------------
// Supported hosts list (for error messages)
// ---------------------------------------------------------------------------

const SUPPORTED_HOSTS = [
  "asuracomic.net",
  "asuratoon.com",
  "asurascans.com",
  "manhuaplus.org",
  "arenascan.com",
  "drakecomic.org",
];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function parseIntStrict(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`--${flagName} must be an integer, got: ${raw}`);
  }
  return n;
}

export class ValidationError extends Error {
  readonly exitCode = ExitCode.CONFIG_ERROR;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();

  // Commander with exitOverride() throws instead of calling process.exit.
  // Distinguish --help / --version (clean exits) from real parse errors.
  try {
    program.parse(argv);
  } catch (err: unknown) {
    // CommanderError has a `code` property.
    const code = (err as { code?: string }).code;
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      // --help and --version already wrote to stdout; exit 0.
      return ExitCode.SUCCESS;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  const opts = program.opts<{
    from: string | undefined;
    to: string | undefined;
    chapters: string | undefined;
    out: string | undefined;
    format: string | undefined;
    concurrency: string | undefined;
    resume: boolean;
    refreshCover: boolean;
    allowPartialZip: boolean;
    allowHeadedCloudflare: boolean;
    flaresolverr: string | undefined;
    logLevel: string | undefined;
    logFormat: string | undefined;
    color: boolean; // commander --no-color sets this to false
    group: string | undefined;
    listGroups: boolean;
  }>();

  const args = program.args;

  // -------------------------------------------------------------------
  // §3 Validation precedence
  // -------------------------------------------------------------------

  // 1. series-url required and must parse as URL
  const rawUrl = args[0];
  if (!rawUrl) {
    process.stderr.write("error: missing required argument <series-url>\n");
    program.help({ error: true });
    return ExitCode.CONFIG_ERROR;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    process.stderr.write(`error: invalid URL: ${rawUrl}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    process.stderr.write(`error: URL must use http or https scheme: ${rawUrl}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  // 2. Resolve URL → adapter (exit 4 if no match)
  const adapter = adapterRegistry.matchUrl(rawUrl);
  if (!adapter) {
    const host = parsedUrl.hostname;
    process.stderr.write(
      `error: No adapter for "${host}".\n` +
      `Supported hosts: ${SUPPORTED_HOSTS.join(", ")}\n`,
    );
    return ExitCode.SOURCE_NOT_FOUND;
  }

  // 3. --from / --to / --chapters parsing and range check
  let fromVal = 0;
  let toVal: number | "latest" = "latest";
  let chaptersVal: number[] | null = null;

  if (opts.chapters !== undefined) {
    if (opts.from !== undefined || opts.to !== undefined) {
      process.stderr.write(
        "error: --chapters cannot be combined with --from or --to\n",
      );
      return ExitCode.CONFIG_ERROR;
    }
    const tokens = opts.chapters.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (tokens.length === 0) {
      process.stderr.write("error: --chapters list is empty\n");
      return ExitCode.CONFIG_ERROR;
    }
    const parsed: number[] = [];
    for (const tok of tokens) {
      const n = parseIntArg(tok, "chapters");
      if (n === null) {
        process.stderr.write(
          `error: --chapters: "${tok}" is not a non-negative integer\n`,
        );
        return ExitCode.CONFIG_ERROR;
      }
      parsed.push(n);
    }
    // Dedupe and sort
    chaptersVal = Array.from(new Set(parsed)).sort((a, b) => a - b);
  }

  if (opts.from !== undefined) {
    const parsed = parseIntArg(opts.from, "from");
    if (parsed === null) {
      process.stderr.write("error: --from must be a non-negative integer\n");
      return ExitCode.CONFIG_ERROR;
    }
    fromVal = parsed;
  }

  if (opts.to !== undefined) {
    if (opts.to === "latest") {
      toVal = "latest";
    } else {
      const n = parseIntArg(opts.to, "to");
      if (n === null) {
        process.stderr.write("error: --to must be a non-negative integer or 'latest'\n");
        return ExitCode.CONFIG_ERROR;
      }
      toVal = n;
    }
  }

  if (chaptersVal === null && toVal !== "latest" && fromVal > toVal) {
    process.stderr.write(
      `error: --from (${fromVal}) is greater than --to (${toVal}) — empty chapter range\n`,
    );
    return ExitCode.CONFIG_ERROR;
  }

  // 4. --concurrency: must be in [1, 3]; values outside → exit 2
  let concurrencyVal = 1;
  if (opts.concurrency !== undefined) {
    const n = parseInt(opts.concurrency, 10);
    if (!Number.isInteger(n) || n < 1 || n > 3) {
      process.stderr.write("error: --concurrency must be an integer in range [1, 3]\n");
      return ExitCode.CONFIG_ERROR;
    }
    concurrencyVal = n;
  }

  // 5. --format validation
  const validFormats = ["webp", "jpg", "png", "original"] as const;
  type FormatOption = typeof validFormats[number];
  let formatVal: FormatOption = "original";
  if (opts.format !== undefined) {
    if (!validFormats.includes(opts.format as FormatOption)) {
      process.stderr.write(
        `error: --format must be one of: ${validFormats.join(", ")} (got: ${opts.format})\n`,
      );
      return ExitCode.CONFIG_ERROR;
    }
    formatVal = opts.format as FormatOption;
  }

  // 6. --out directory: create if needed, assert writable
  const outRaw = opts.out ?? "./dist";
  const outDir = isAbsolute(outRaw) ? outRaw : resolvePath(process.cwd(), outRaw);

  try {
    await mkdir(outDir, { recursive: true });
    await access(outDir, constants.W_OK);
  } catch {
    process.stderr.write(`error: output directory is not writable: ${outDir}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  // 7. --log-level validation
  const validLogLevels = ["debug", "info", "warn", "error"] as const;
  type LogLevel = typeof validLogLevels[number];
  const logLevelRaw = opts.logLevel ?? "info";
  if (!validLogLevels.includes(logLevelRaw as LogLevel)) {
    process.stderr.write(
      `error: --log-level must be one of: ${validLogLevels.join(", ")} (got: ${logLevelRaw})\n`,
    );
    return ExitCode.CONFIG_ERROR;
  }
  const logLevel = logLevelRaw as LogLevel;

  // 8. --log-format validation
  const validLogFormats = ["json", "pretty"] as const;
  type LogFormatOption = typeof validLogFormats[number];
  const logFormatRaw = opts.logFormat ?? "pretty";
  if (!validLogFormats.includes(logFormatRaw as LogFormatOption)) {
    process.stderr.write(
      `error: --log-format must be one of: json, pretty (got: ${logFormatRaw})\n`,
    );
    return ExitCode.CONFIG_ERROR;
  }
  const logFormat = logFormatRaw as LogFormatOption;

  // -------------------------------------------------------------------
  // Build RunConfig and validate through Zod schema
  // -------------------------------------------------------------------

  // Map the four-option format to the two-option schema format.
  // jpg/png are treated as "original" at the schema level; the packager
  // reads the raw format string from the pipeline config for future use.
  const schemaFormat = formatVal === "webp" ? "webp" : "original";

  const rawConfig = {
    seriesUrl: rawUrl,
    from: fromVal,
    to: toVal,
    chapters: chaptersVal,
    out: outDir,
    format: schemaFormat,
    concurrency: concurrencyVal,
    resume: opts.resume,
    refreshCover: opts.refreshCover,
    allowPartialZip: opts.allowPartialZip,
    allowHeadedCloudflare: opts.allowHeadedCloudflare,
    flaresolverrUrl: opts.flaresolverr ?? "http://localhost:8191/v1",
    headful: opts.allowHeadedCloudflare,
    cookiesFrom: null,
    log: logFormat,
    dryRun: false,
    group: opts.group ?? null,
  };

  const parseResult = runConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    process.stderr.write(`error: invalid configuration:\n`);
    for (const issue of parseResult.error.issues) {
      process.stderr.write(`  ${issue.path.join(".")}: ${issue.message}\n`);
    }
    return ExitCode.CONFIG_ERROR;
  }

  const config = parseResult.data;

  // -------------------------------------------------------------------
  // Build context, install handlers, attach reporter, run pipeline
  // -------------------------------------------------------------------

  const logger = createPinoSink({
    level: logLevel,
    ...(logFormat === "pretty" ? { transport: { target: "pino-pretty" } } : {}),
  });

  const runCtx = await buildRunContext(config);
  const controller = new AbortController();

  installSignalHandlers(controller, logger, runCtx.eventBus);

  // -------------------------------------------------------------------
  // Group resolution (sites that support scanlation groups)
  //
  // Flow:
  //   --list-groups       → print and exit 0 (or 2 if adapter has no groups)
  //   --group <name|id>   → validate against adapter.listGroups; reject mismatch
  //   neither, multi-group → prompt on TTY; exit 2 with list otherwise
  //   neither, single grp → auto-select silently
  //   neither, zero grp   → proceed with group=null (adapter handles)
  // -------------------------------------------------------------------
  if (opts.listGroups) {
    const result = await runListGroups(adapter, runCtx.ctx, config.seriesUrl);
    await runCtx.cleanup();
    return result;
  }

  try {
    const resolvedGroup = await resolveGroupSelection(
      adapter,
      runCtx.ctx,
      config.seriesUrl,
      config.group,
    );
    if (resolvedGroup !== config.group) {
      // RunConfig is declared readonly; mutating here is intentional and confined
      // to the CLI startup window before pipeline.run reads the value.
      (config as { group: string | null }).group = resolvedGroup;
      (runCtx.ctx as { config: RunConfig }).config = config;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    await runCtx.cleanup();
    return ExitCode.CONFIG_ERROR;
  }

  const noColor = opts.color === false;
  const reporter = new ProgressReporter(runCtx.eventBus, logger, {
    logFormat,
    noColor,
  });
  const detachReporter = reporter.attach();

  const pipeline = new Pipeline({
    store: runCtx.store,
    http: runCtx.http,
    throttler: runCtx.throttler,
    jar: runCtx.jar,
    browser: runCtx.browser,
    cf: runCtx.cf,
    eventBus: runCtx.eventBus,
    ctx: runCtx.ctx,
  });

  let exitCode: number = ExitCode.GENERIC;

  try {
    const result = await pipeline.run(config, controller.signal);

    // Print summary if not already shown via events
    if (logFormat === "json") {
      process.stdout.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "cli.summary",
          payload: {
            status: result.status,
            chaptersCompleted: result.chaptersCompleted,
            chaptersFailed: result.chaptersFailed.length,
            outputPath: result.outputPath ?? null,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
          },
        }) + "\n",
      );
    }

    exitCode = result.exitCode;
  } catch (err: unknown) {
    const isForcedAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted")) &&
      controller.signal.aborted;

    exitCode = mapErrorToExitCode(err, isForcedAbort);

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, exitCode }, `unhandled error: ${msg}`);
  } finally {
    detachReporter();
    await runCtx.cleanup();
  }

  return exitCode;
}

// ---------------------------------------------------------------------------
// Commander program definition
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const version = readVersion();

  const program = new Command();

  program
    .name("verreaux-scrape")
    .description("Multi-source manhwa/manga scraper producing Verreaux-compatible ZIPs")
    .version(version, "--version", "Output the current version")
    .argument("<series-url>", "URL of the series page to scrape")
    .option("--from <n>", "First chapter number (inclusive). Default: 0")
    .option("--to <n|latest>", "Last chapter number (inclusive) or 'latest'. Default: latest")
    .option("--chapters <list>", "Comma-separated chapter numbers (e.g. 5,12,40). Overrides --from/--to.")
    .option("--out <path>", "Output directory. Default: ./dist")
    .option("--format <webp|jpg|png|original>", "Image format preference. Default: original")
    .option("--concurrency <n>", "Chapters in parallel. Range 1-3. Default: 1")
    .option("--resume", "Resume a partial run for this series-url", false)
    .option("--refresh-cover", "Force re-fetch of the series cover (overrides SHA-1 cache)", false)
    .option("--allow-partial-zip", "Build ZIP even if some chapters failed", false)
    .option("--allow-headed-cloudflare", "Open a visible browser for human CF challenge resolution", false)
    .option("--flaresolverr <url>", "FlareSolverr endpoint. Default: http://localhost:8191/v1")
    .option("--log-level <level>", "debug|info|warn|error. Default: info")
    .option("--log-format <json|pretty>", "Default: pretty")
    .option("--no-color", "Disable colored output")
    .option(
      "--group <name|id>",
      "Scanlation group to download from (for sites that expose group attribution)",
    )
    .option(
      "--list-groups",
      "Print available scanlation groups for the series and exit. Requires <series-url>.",
      false,
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  verreaux-scrape https://asuracomic.net/series/test-series --to latest\n" +
      "  verreaux-scrape https://manhuaplus.org/manga/my-series --from 0 --to 83\n" +
      "  verreaux-scrape https://asurascans.com/comics/foo --chapters 5,12,40\n" +
      "  verreaux-scrape https://asurascans.com/comics/foo --from 7 --to 7\n",
    )
    .exitOverride(); // Prevent commander calling process.exit directly.

  return program;
}

// ---------------------------------------------------------------------------
// Integer argument parser (returns null on failure instead of throwing)
// ---------------------------------------------------------------------------

function parseIntArg(raw: string, _flagName: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Group resolution helpers (CLI startup)
// ---------------------------------------------------------------------------

function renderGroupTable(groups: readonly GroupInfo[]): string {
  if (groups.length === 0) return "  (no groups)\n";
  const lines: string[] = [];
  for (const g of groups) {
    const slug = g.slug ? `  [${g.slug}]` : "";
    const count = typeof g.chapterCount === "number" ? `  (${g.chapterCount} chapters)` : "";
    lines.push(`  - ${g.name}${slug}${count}  — id=${g.id}`);
  }
  return lines.join("\n") + "\n";
}

async function runListGroups(
  adapter: SourceAdapter,
  ctx: AdapterContext,
  seriesUrl: string,
): Promise<number> {
  if (typeof adapter.listGroups !== "function") {
    process.stderr.write(
      `error: adapter "${adapter.id}" does not expose scanlation groups\n`,
    );
    return ExitCode.CONFIG_ERROR;
  }
  let groups: readonly GroupInfo[];
  try {
    groups = await adapter.listGroups(ctx, seriesUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: failed to list groups: ${msg}\n`);
    return ExitCode.GENERIC;
  }
  process.stdout.write(`Available groups for ${seriesUrl}:\n`);
  process.stdout.write(renderGroupTable(groups));
  return ExitCode.SUCCESS;
}

function matchGroupByInput(
  groups: readonly GroupInfo[],
  input: string,
): GroupInfo | null {
  const needle = input.trim().toLowerCase();
  if (needle === "") return null;
  for (const g of groups) {
    if (g.id === input) return g;
  }
  for (const g of groups) {
    if (g.name.toLowerCase() === needle) return g;
    if (g.slug && g.slug.toLowerCase() === needle) return g;
  }
  return null;
}

async function promptForGroup(groups: readonly GroupInfo[]): Promise<string | null> {
  process.stdout.write("\nMultiple scanlation groups available:\n");
  groups.forEach((g, i) => {
    const slug = g.slug ? `  [${g.slug}]` : "";
    const count = typeof g.chapterCount === "number" ? `  (${g.chapterCount} chapters)` : "";
    process.stdout.write(`  ${i + 1}. ${g.name}${slug}${count}  — id=${g.id}\n`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Select group [1-${groups.length}]: `)).trim();
    if (answer === "") return null;
    // Accept either the row number or a name/id/slug.
    const asIdx = Number.parseInt(answer, 10);
    if (Number.isInteger(asIdx) && asIdx >= 1 && asIdx <= groups.length) {
      return groups[asIdx - 1]!.id;
    }
    const matched = matchGroupByInput(groups, answer);
    return matched?.id ?? null;
  } finally {
    rl.close();
  }
}

async function resolveGroupSelection(
  adapter: SourceAdapter,
  ctx: AdapterContext,
  seriesUrl: string,
  requested: string | null,
): Promise<string | null> {
  if (typeof adapter.listGroups !== "function") {
    // Adapter has no concept of groups; nothing to resolve.
    if (requested !== null) {
      throw new Error(
        `--group is not supported by adapter "${adapter.id}"`,
      );
    }
    return null;
  }

  const groups = await adapter.listGroups(ctx, seriesUrl);

  if (groups.length === 0) {
    // No groups → adapter will treat as Unknown release.
    if (requested !== null) {
      throw new Error(
        `--group="${requested}" was set, but this series has no group attribution`,
      );
    }
    return null;
  }

  if (requested !== null) {
    const matched = matchGroupByInput(groups, requested);
    if (!matched) {
      throw new Error(
        `--group="${requested}" did not match any group for this series.\n` +
        `Available:\n${renderGroupTable(groups)}` +
        `Tip: rerun with --list-groups to see this list.`,
      );
    }
    return matched.id;
  }

  if (groups.length === 1) {
    return groups[0]!.id;
  }

  // Multiple groups, no selection.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const picked = await promptForGroup(groups);
    if (picked === null) {
      throw new Error(
        "no group selected.\n" +
        `Available:\n${renderGroupTable(groups)}` +
        `Tip: pass --group <name|id> to skip the prompt.`,
      );
    }
    return picked;
  }

  throw new Error(
    `this series has ${groups.length} groups; pass --group <name|id>.\n` +
    `Available:\n${renderGroupTable(groups)}`,
  );
}
