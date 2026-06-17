import { describe, it, expect } from "vitest";
import { runningStatus, finalStatus } from "../../src/pi/status.js";

describe("run status", () => {
  it("builds a running status with a start time", () => {
    const s = runningStatus("2026-06-16T15:30:12Z");
    expect(s.state).toBe("running");
    expect(s.startedAt).toBe("2026-06-16T15:30:12Z");
    expect(s.finishedAt).toBeNull();
    expect(s.exitCode).toBeNull();
  });

  it("marks succeeded when exit code is 0", () => {
    const s = finalStatus(runningStatus("t0"), 0, "t1");
    expect(s.state).toBe("succeeded");
    expect(s.exitCode).toBe(0);
    expect(s.finishedAt).toBe("t1");
    expect(s.startedAt).toBe("t0");
  });

  it("marks failed when exit code is non-zero", () => {
    const s = finalStatus(runningStatus("t0"), 5, "t1", "boom");
    expect(s.state).toBe("failed");
    expect(s.exitCode).toBe(5);
    expect(s.message).toBe("boom");
  });
});
