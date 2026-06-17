// scripts/pi-api.mjs
// HTTP API entrypoint. Wires Node http to the tested handleApiRequest core.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { handleApiRequest } from "../dist/pi/api.js";
import { PgAccountStore } from "../dist/pi/pgStore.js";
import { verifyTotp } from "../dist/pi/totp.js";

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
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PgAccountStore(pool);
  await store.init();
  deps.store = store;
  deps.verifyOtp = (code) => verifyTotp(SECRET, code, Date.now());
  deps.newToken = () => randomBytes(32).toString("hex");
  deps.newId = () => randomUUID();
  console.log("[pi-api] sync backend enabled (postgres)");
} else {
  console.log("[pi-api] sync backend disabled (no DATABASE_URL)");
}
// `||` (not `??`) so an empty-string PORT (a common .env/compose accident)
// falls back to 8080 instead of Number("") === 0 binding a random port.
const PORT = Number(process.env.PORT || 8080);
createServer((req, res) => {
  handleApiRequest(req, res, deps).catch((err) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err?.message ?? "internal error" }));
  });
}).listen(PORT, () => console.log(`[pi-api] listening on :${PORT}`));
