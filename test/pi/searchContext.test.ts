import { describe, it, expect } from "vitest";
import { buildSearchContext } from "../../src/pi/searchContext.js";

describe("buildSearchContext", () => {
  it("provides http, cookies, throttle, logger, and a signal", async () => {
    const { ctx, cleanup } = buildSearchContext();
    expect(ctx.http).toBeTruthy();
    expect(ctx.cookies).toBeTruthy();
    expect(ctx.throttle).toBeTruthy();
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    await cleanup();
  });
});
