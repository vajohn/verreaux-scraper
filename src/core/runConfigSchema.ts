import { z } from "zod";

// Zod schema mirroring §3 CLI flags. Used for validation in INIT state.
export const runConfigSchema = z.object({
  seriesUrl: z.string().url({ message: "ERR_BAD_URL" }),
  from: z.number().int().min(0).default(0),
  to: z.union([z.number().int().min(0), z.literal("latest")]).default("latest"),
  /** Explicit chapter list — if non-null, overrides from/to. Sorted, deduped. */
  chapters: z.array(z.number().int().min(0)).readonly().nullable().default(null),
  out: z.string().default("./dist"),
  format: z.enum(["webp", "original"]).default("webp"),
  // §3: concurrency in [1,5]
  concurrency: z.number().int().min(1).max(5).default(3),
  resume: z.boolean().default(false),
  refreshCover: z.boolean().default(false),
  allowPartialZip: z.boolean().default(false),
  flaresolverrUrl: z
    .string()
    .url()
    .nullable()
    .default("http://localhost:8191"),
  headful: z.boolean().default(false),
  cookiesFrom: z.string().nullable().default(null),
  log: z.enum(["json", "pretty"]).default("pretty"),
  dryRun: z.boolean().default(false),
  // Controls whether Playwright may be launched in headed mode for manual
  // Turnstile solving (§7 CF_HUMAN_PROMPT). Maps to --headful flag.
  allowHeadedCloudflare: z.boolean().default(false),
  // Scanlation group selection (--group). Adapter-specific identifier or
  // human-readable name; null means "let the adapter prompt or auto-select".
  group: z.string().nullable().default(null),
});
