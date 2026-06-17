// scripts/scrape-pi-lib.mjs
// Pure command planner — kept separate so it is unit-testable without SSH.
export function buildCommands({ host, user, id, localJobPath, outDir, remoteRoot = "~/verreaux/data" }) {
  const target = `${user}@${host}`;
  return {
    upload: ["scp", localJobPath, `${target}:${remoteRoot}/jobs/${id}.json`],
    status: ["ssh", target, `cat ${remoteRoot}/done/${id}/status.json`],
    log: ["ssh", target, `tail -n 40 ${remoteRoot}/done/${id}/run.log`],
    download: ["scp", `${target}:${remoteRoot}/done/${id}/*.zip`, `${outDir}/`],
  };
}
