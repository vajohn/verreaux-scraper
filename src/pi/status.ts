export type RunState = "running" | "succeeded" | "failed";

export interface RunStatus {
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  message: string | null;
}

export function runningStatus(startedAt: string): RunStatus {
  return { state: "running", startedAt, finishedAt: null, exitCode: null, message: null };
}

export function finalStatus(
  prev: RunStatus,
  exitCode: number,
  finishedAt: string,
  message: string | null = null,
): RunStatus {
  return {
    ...prev,
    state: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    finishedAt,
    message,
  };
}
