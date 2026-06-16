import { describe, it, expect } from "vitest";
import { buildCommands } from "../../scripts/scrape-pi-lib.mjs";

describe("scrape-pi command planner", () => {
  it("plans scp upload, status poll, and zip download for a host", () => {
    const c = buildCommands({
      host: "pajohn.local",
      user: "vajohn",
      id: "20260616-153012-abcd",
      localJobPath: "/tmp/20260616-153012-abcd.json",
      outDir: "./output",
    });
    expect(c.upload).toEqual(["scp", "/tmp/20260616-153012-abcd.json", "vajohn@pajohn.local:~/verreaux/data/jobs/20260616-153012-abcd.json"]);
    expect(c.status).toEqual(["ssh", "vajohn@pajohn.local", "cat ~/verreaux/data/done/20260616-153012-abcd/status.json"]);
    expect(c.download).toEqual(["scp", "vajohn@pajohn.local:~/verreaux/data/done/20260616-153012-abcd/*.zip", "./output/"]);
  });
});
