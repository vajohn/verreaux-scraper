// scripts/pi-api.mjs
// HTTP API entrypoint. Wires Node http to the tested handleApiRequest core.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { handleApiRequest } from "../dist/pi/api.js";

const ROOT = process.env.VERREAUX_ROOT ?? "/work";
const SECRET = process.env.SCRAPE_TOTP_SECRET;
if (!SECRET) {
  console.error("SCRAPE_TOTP_SECRET is required");
  process.exit(1);
}
const deps = {
  dirs: { jobs: join(ROOT, "jobs"), done: join(ROOT, "done"), state: join(ROOT, "state") },
  secret: SECRET,
  now: () => Date.now(),
  newSuffix: () => randomBytes(2).toString("hex"),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};
const PORT = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  handleApiRequest(req, res, deps).catch((err) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err?.message ?? "internal error" }));
  });
}).listen(PORT, () => console.log(`[pi-api] listening on :${PORT}`));
