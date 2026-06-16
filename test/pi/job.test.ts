import { describe, it, expect } from "vitest";
import { generateJobId, parseJob, serializeJob } from "../../src/pi/job.js";

describe("job model", () => {
  it("generates a sortable id from a fixed date + suffix", () => {
    const id = generateJobId(new Date("2026-06-16T15:30:12Z"), "ab12");
    expect(id).toBe("20260616-153012-ab12");
  });

  it("round-trips a valid scrape job", () => {
    const json = serializeJob({
      id: "20260616-153012-ab12",
      type: "scrape",
      url: "https://qimanhwa.com/series/x",
      args: "--from 1 --to 10",
    });
    const job = parseJob(json);
    expect(job.type).toBe("scrape");
    expect(job.url).toBe("https://qimanhwa.com/series/x");
    expect(job.args).toBe("--from 1 --to 10");
  });

  it("defaults type to scrape and args to empty string", () => {
    const job = parseJob('{"id":"i","url":"https://x.test/s"}');
    expect(job.type).toBe("scrape");
    expect(job.args).toBe("");
  });

  it("rejects a job with a missing/invalid url", () => {
    expect(() => parseJob('{"id":"i","url":"not-a-url"}')).toThrow(/url/i);
    expect(() => parseJob('{"id":"i"}')).toThrow(/url/i);
  });

  it("rejects an unknown type", () => {
    expect(() => parseJob('{"id":"i","url":"https://x.test/s","type":"nope"}')).toThrow(/type/i);
  });

  it("rejects malformed json with a clear message", () => {
    expect(() => parseJob("{not json")).toThrow(/json/i);
  });
});
