// One-off inspector for qimanhwa.com.
// Run with:  node scripts/probe-qiscan.mjs

import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { writeFileSync } from "node:fs";

chromium.use(stealth());

const SERIES_URL = "https://qimanhwa.com/series/demonic-emperor";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
});

const page = await ctx.newPage();

const apiCalls = [];
page.on("response", (resp) => {
  const u = resp.url();
  if (/(api|graphql|chapter|series)/i.test(u) && resp.request().resourceType() !== "image") {
    apiCalls.push({
      url: u,
      method: resp.request().method(),
      status: resp.status(),
      ct: resp.headers()["content-type"] || "",
    });
  }
});

console.log("=== SERIES ===", SERIES_URL);
const resp = await page.goto(SERIES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
console.log("status:", resp?.status(), "final:", page.url());

await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(4000);

// Dump raw HTML for inspection
const html = await page.content();
writeFileSync("/tmp/qiscan-series-rendered.html", html);
console.log("RAW HTML size:", html.length, "saved to /tmp/qiscan-series-rendered.html");

const series = await page.evaluate(() => {
  const sel = (s) => document.querySelector(s);
  const all = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el?.textContent ?? "").trim().replace(/\s+/g, " ");

  const anchors = all("a[href]").map((a) => ({
    href: a.getAttribute("href") || "",
    text: txt(a).slice(0, 80),
  }));
  const chapterCandidates = anchors.filter((a) => /chapter/i.test(a.href));

  // __NEXT_DATA__
  const nextData = document.getElementById("__NEXT_DATA__");
  let nextDataPreview = null;
  if (nextData) {
    try {
      const j = JSON.parse(nextData.textContent || "{}");
      nextDataPreview = {
        keys: Object.keys(j),
        propsKeys: j.props ? Object.keys(j.props) : null,
        pagePropsKeys: j.props?.pageProps ? Object.keys(j.props.pageProps) : null,
        buildId: j.buildId,
        page: j.page,
        query: j.query,
      };
    } catch {
      nextDataPreview = { error: "parse failed" };
    }
  }

  return {
    title: txt(sel("h1")) || document.title,
    ogImage: sel('meta[property="og:image"]')?.getAttribute("content") || null,
    ogTitle: sel('meta[property="og:title"]')?.getAttribute("content") || null,
    description: sel('meta[name="description"]')?.getAttribute("content") || null,
    anchorTotal: anchors.length,
    chapterAnchorCount: chapterCandidates.length,
    firstAnchors: anchors.slice(0, 10),
    firstChapterAnchors: chapterCandidates.slice(0, 5),
    lastChapterAnchors: chapterCandidates.slice(-5),
    nextDataPreview,
    htmlHasNextData: !!nextData,
  };
});

console.log(JSON.stringify(series, null, 2));

console.log("\n=== NETWORK API CALLS ===");
console.log(JSON.stringify(apiCalls.slice(0, 20), null, 2));

await browser.close();
