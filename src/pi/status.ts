export type RunState = "running" | "succeeded" | "failed";

export interface RunStatus {
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  message: string | null;
  /** A partial-but-resumable outcome (e.g. rate-limited): the run failed
   *  overall yet produced usable output the app can import and later resume. */
  partial: boolean;
  /** True when an output.zip exists for the run despite a non-zero exit. */
  hasOutput: boolean;
}

export function runningStatus(startedAt: string): RunStatus {
  return {
    state: "running",
    startedAt,
    finishedAt: null,
    exitCode: null,
    message: null,
    partial: false,
    hasOutput: false,
  };
}

export function finalStatus(
  prev: RunStatus,
  exitCode: number,
  finishedAt: string,
  message: string | null = null,
  flags: { partial?: boolean; hasOutput?: boolean } = {},
): RunStatus {
  return {
    ...prev,
    state: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    finishedAt,
    message,
    partial: flags.partial ?? false,
    hasOutput: flags.hasOutput ?? false,
  };
}
