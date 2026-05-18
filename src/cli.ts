// Barrel re-export for the CLI surface. Consumed by tests and external tooling.
export { runCli, ValidationError } from "./cli/program.js";
export { ProgressReporter } from "./cli/progress.js";
export { installSignalHandlers } from "./cli/signals.js";
export { mapErrorToExitCode } from "./cli/errorMap.js";
