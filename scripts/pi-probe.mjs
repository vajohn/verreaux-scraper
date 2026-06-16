// scripts/pi-probe.mjs
// Consolidated qimanhwa diagnostic (was qimanhwa-probe.yml). Writes a
// classification + captured DOM/JSON/screenshot into --out for inspection.
// Usage: node scripts/pi-probe.mjs <url> --out <dir>
import { addExtra } from "playwright-extra";
import { chromium as base } from "playwright";
import Stealth from "puppeteer-extra-plugin-stealth";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const url = process.argv[2] ?? "https://qimanhwa.com/";
const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : "./probe-out";
mkdirSync(outDir, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const chromium = addExtra(base);
chromium.use(Stealth());

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const apiHits = [];
page.on("response", async (resp) => {
  const u = resp.url();
  if (/\/api\//i.test(u)) {
    let body = "";
    if (/json/i.test(resp.headers()["content-type"] || "")) {
      try { body = (await resp.text()).slice(0, 4000); } catch {}
    }
    apiHits.push({ url: u, status: resp.status() });
    if (body) writeFileSync(join(outDir, `api_${u.replace(/[^a-z0-9]+/gi, "_").slice(-60)}.json`), body);
  }
});

let verdict = "ERROR";
try {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const status = resp ? resp.status() : "no-response";
  await page.waitForTimeout(8000);
  const title = await page.title();
  const bodyText = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 300);
  const isChallenge = /just a moment|verify you are human|cf-chl|challenge/i.test(title + " " + bodyText);
  await page.screenshot({ path: join(outDir, "screenshot.png") });
  writeFileSync(join(outDir, "home.html"), await page.content());
  verdict = isChallenge ? "BLOCKED — Cloudflare challenge" : /manhwa/i.test(title) ? "SUCCESS — content rendered" : "INCONCLUSIVE";
  console.log(JSON.stringify({ status, title, verdict, apiHits: apiHits.length }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ verdict: "ERROR", message: err.message }, null, 2));
} finally {
  writeFileSync(join(outDir, "_requests.json"), JSON.stringify(apiHits, null, 2));
  await browser.close();
}
// Exit 0 even on a block — a probe "result" is success for the worker.
process.exit(0);
