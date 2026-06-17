export type JobType = "scrape" | "probe";

export interface ScrapeJob {
  id: string;
  type: JobType;
  /** Series URL. Required and must be http(s). */
  url: string;
  /** Extra CLI args, word-split downstream. May be empty. */
  args: string;
}

/** `YYYYMMDD-HHMMSS-<suffix>` in UTC. Sortable by creation time. */
export function generateJobId(at: Date, suffix: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  return `${stamp}-${suffix}`;
}

export function serializeJob(job: ScrapeJob): string {
  return JSON.stringify(job, null, 2);
}

export function parseJob(raw: string): ScrapeJob {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("invalid job JSON: could not parse");
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("invalid job JSON: expected an object");
  }
  const o = obj as Record<string, unknown>;

  const type = (o["type"] ?? "scrape") as string;
  if (type !== "scrape" && type !== "probe") {
    throw new Error(`invalid job type: ${type}`);
  }

  const url = o["url"];
  if (typeof url !== "string") throw new Error("invalid job: url is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid job: url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid job: url must be http(s): ${url}`);
  }

  const args = typeof o["args"] === "string" ? o["args"] : "";
  const id = typeof o["id"] === "string" ? o["id"] : "";
  return { id, type, url, args };
}
