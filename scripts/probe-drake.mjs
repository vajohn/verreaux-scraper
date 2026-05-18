// One-off inspector for drakecomic.org.
// Run with:  node scripts/probe-drake.mjs

import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { writeFileSync } from "node:fs";

chromium.use(stealth());

const SERIES_URL =
  "https://drakecomic.org/manga/logging-10000-years-into-the-future/";

const HEADFUL = process.env.HEADFUL === "1";
const browser = await chromium.launch({ headless: !HEADFUL });
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
  if (
    /(admin-ajax|wp-json|api|graphql|chapter|series|ajax)/i.test(u) &&
    resp.request().resourceType() !== "image"
  ) {
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

// Wait for cf_clearance cookie (CF Turnstile auto-solves on managed challenges)
const deadline = Date.now() + 75_000;
let cleared = false;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies();
  if (cookies.some((c) => c.name === "cf_clearance")) { cleared = true; break; }
  await page.waitForTimeout(1500);
}
console.log("cf_clearance:", cleared ? "obtained" : "MISSING");

if (cleared) {
  // Re-navigate so the real page loads with the clearance cookie applied
  const resp2 = await page.goto(SERIES_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("re-nav status:", resp2?.status());
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

const html = await page.content();
writeFileSync("/tmp/drake-series-rendered.html", html);
console.log("RAW HTML size:", html.length, "saved to /tmp/drake-series-rendered.html");

const probe = await page.evaluate(() => {
  const sel = (s) => document.querySelector(s);
  const all = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el?.textContent ?? "").trim().replace(/\s+/g, " ");

  const anchors = all("a[href]").map((a) => ({
    href: a.getAttribute("href") || "",
    text: txt(a).slice(0, 80),
  }));
  const chapterAnchors = anchors.filter((a) => /chapter|ch-\d|\/manga\/.+\/.+/i.test(a.href));

  // Look for common WordPress/Madara/Themesia chapter list containers.
  const containers = {
    chapterlistTs: !!sel("#chapterlist"),
    listingChaptersWpManga: !!sel("ul.main.version-chap"),
    listingChaptersWpMangaLi: all("ul.main.version-chap li").length,
    wpMangaChapterRows: all("li.wp-manga-chapter").length,
    chapterlistLi: all("#chapterlist li").length,
    chapterListNumLi: all("#chapterlist li[data-num]").length,
  };

  // Generator / theme hints
  const generator = sel('meta[name="generator"]')?.getAttribute("content") || null;
  const bodyClasses = (document.body.className || "").split(/\s+/).slice(0, 30);
  const hasMadara = bodyClasses.some((c) => /madara|wp-manga/.test(c));
  const hasThemesia = !!document.querySelector("script[src*='themesia'], link[href*='themesia']");

  // Sniff inline scripts for known reader hooks
  const inlineScripts = all("script:not([src])").map((s) => s.textContent || "");
  const hasTsReader = inlineScripts.some((s) => s.includes("ts_reader.run"));
  const hasChapterImages = inlineScripts.some((s) => s.includes("chapter_images"));
  const adminAjax = inlineScripts.some((s) => s.includes("admin-ajax.php"));

  return {
    title: txt(sel("h1.entry-title")) || txt(sel("h1")) || document.title,
    ogImage: sel('meta[property="og:image"]')?.getAttribute("content") || null,
    ogTitle: sel('meta[property="og:title"]')?.getAttribute("content") || null,
    description: sel('meta[name="description"]')?.getAttribute("content") || null,
    generator,
    bodyClasses,
    hasMadara,
    hasThemesia,
    hasTsReader,
    hasChapterImages,
    adminAjax,
    containers,
    anchorTotal: anchors.length,
    chapterAnchorCount: chapterAnchors.length,
    firstChapterAnchors: chapterAnchors.slice(0, 5),
    lastChapterAnchors: chapterAnchors.slice(-5),
    wpPostImage:
      sel("img.wp-post-image")?.getAttribute("src") ||
      sel("img.wp-post-image")?.getAttribute("data-src") ||
      null,
  };
});

console.log(JSON.stringify(probe, null, 2));

console.log("\n=== NETWORK API CALLS ===");
console.log(JSON.stringify(apiCalls.slice(0, 20), null, 2));

// If we found chapter anchors, fetch one to understand the reader page.
const firstChapter =
  probe.firstChapterAnchors?.find((a) => /drakecomic\.org/.test(a.href))?.href ||
  probe.firstChapterAnchors?.[0]?.href;

if (firstChapter) {
  console.log("\n=== CHAPTER ===", firstChapter);
  const cresp = await page.goto(firstChapter, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("status:", cresp?.status(), "final:", page.url());
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const chtml = await page.content();
  writeFileSync("/tmp/drake-chapter-rendered.html", chtml);
  console.log("RAW HTML size:", chtml.length, "saved to /tmp/drake-chapter-rendered.html");

  const cprobe = await page.evaluate(() => {
    const all = (s) => Array.from(document.querySelectorAll(s));
    const inlineScripts = all("script:not([src])").map((s) => s.textContent || "");
    // Cards used by various reader plugins:
    const imgInReader = all("#readerarea img, .reading-content img, div.page-break img, img.wp-manga-chapter-img");
    const imgs = imgInReader.map((i) => ({
      src: i.getAttribute("src") || i.getAttribute("data-src") || i.getAttribute("data-lazy-src") || "",
      cls: i.className,
    }));
    return {
      readerareaImgs: all("#readerarea img").length,
      readingContentImgs: all(".reading-content img").length,
      wpMangaChapterImgs: all("img.wp-manga-chapter-img").length,
      pageBreakImgs: all("div.page-break img").length,
      firstImgs: imgs.slice(0, 5),
      lastImgs: imgs.slice(-3),
      hasTsReader: inlineScripts.some((s) => s.includes("ts_reader.run")),
      hasChapterImages: inlineScripts.some((s) => s.includes("chapter_images")),
      hasNextData: !!document.getElementById("__NEXT_DATA__"),
    };
  });
  console.log(JSON.stringify(cprobe, null, 2));
}

await browser.close();
