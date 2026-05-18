// Inspect the manually-captured drakecomic.org HTML to determine adapter pattern.
import { readFileSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";

const SERIES_HTML = "/Users/JLAJ9408/Documents/Verreaux/tmp/drake-series.raw.html";
const CHAPTER_HTML = "/Users/JLAJ9408/Documents/Verreaux/tmp/drake-chapter.raw.html";

function summarise(label, file) {
  const html = readFileSync(file, "utf8");
  const $ = cheerio.load(html);

  const sel = (s, attr) => {
    const el = $(s).first();
    if (!el.length) return null;
    return attr ? el.attr(attr) ?? null : el.text().trim().replace(/\s+/g, " ");
  };
  const count = (s) => $(s).length;

  console.log(`\n=== ${label} ===  size=${html.length}`);

  // Identity
  console.log("title:                 ", sel("title"));
  console.log("og:title:              ", sel('meta[property="og:title"]', "content"));
  console.log("og:image:              ", sel('meta[property="og:image"]', "content"));
  console.log("og:url:                ", sel('meta[property="og:url"]', "content"));
  console.log("generator:             ", sel('meta[name="generator"]', "content"));
  console.log("body classes:          ", $("body").attr("class")?.slice(0, 200) || null);

  // Theme/plugin sniffing
  const html_lc = html.toLowerCase();
  const flags = {
    "ts_reader.run(":           html_lc.includes("ts_reader.run("),
    "chapter_images":           html_lc.includes("chapter_images"),
    "wp-manga":                 html_lc.includes("wp-manga"),
    "madara":                   html_lc.includes("madara"),
    "themesia":                 html_lc.includes("themesia"),
    "admin-ajax.php":           html_lc.includes("admin-ajax.php"),
    "wp-json/":                 html_lc.includes("wp-json/"),
    "#readerarea":              html.includes("readerarea"),
    "entry-title":              html.includes("entry-title"),
    "wp-post-image":            html.includes("wp-post-image"),
    "version-chap":             html.includes("version-chap"),
    "chapterlist":              html.includes("chapterlist"),
    "chapternum":               html.includes("chapternum"),
    "ListChapters":             html.includes("ListChapters"),
    "manga_get_chapters":       html_lc.includes("manga_get_chapters"),
  };
  console.log("plugin flags:");
  for (const [k, v] of Object.entries(flags)) console.log("  ", k.padEnd(22), v);

  // Heading candidates
  console.log("h1 (entry-title):      ", sel("h1.entry-title"));
  console.log("h1 (any):              ", sel("h1"));
  console.log(".post-title h1:        ", sel(".post-title h1"));
  console.log("img.wp-post-image src: ", sel("img.wp-post-image", "src"));
  console.log("img.wp-post-image data-src:", sel("img.wp-post-image", "data-src"));

  // Chapter list selectors common across WP manga themes
  console.log("\nchapter container counts:");
  console.log("  #chapterlist li        ", count("#chapterlist li"));
  console.log("  #chapterlist li[data-num]", count("#chapterlist li[data-num]"));
  console.log("  ul.main.version-chap li", count("ul.main.version-chap li"));
  console.log("  li.wp-manga-chapter    ", count("li.wp-manga-chapter"));
  console.log("  .listing-chapters_wrap a", count(".listing-chapters_wrap a"));
  console.log("  .chapter-link          ", count(".chapter-link"));
  console.log("  .wp-manga-chapter a    ", count(".wp-manga-chapter a"));

  // Pull a few chapter links from the most populated container
  const candidates = [
    "#chapterlist li a",
    "ul.main.version-chap li a",
    "li.wp-manga-chapter a",
    ".listing-chapters_wrap a",
    ".chapter-link",
  ];
  for (const sel2 of candidates) {
    const n = $(sel2).length;
    if (n === 0) continue;
    console.log(`\nFIRST 3 + LAST 3 from "${sel2}" (${n} total)`);
    const links = $(sel2).map((_, el) => ({
      href: ($(el).attr("href") || "").trim(),
      text: $(el).text().trim().replace(/\s+/g, " ").slice(0, 80),
      dataNum: $(el).closest("li").attr("data-num") || null,
    })).get();
    for (const l of links.slice(0, 3)) console.log("  ", JSON.stringify(l));
    if (links.length > 6) console.log("   ...");
    for (const l of links.slice(-3)) console.log("  ", JSON.stringify(l));
  }

  // Reader / image extraction signals
  console.log("\nreader image counts:");
  console.log("  #readerarea img        ", count("#readerarea img"));
  console.log("  .reading-content img   ", count(".reading-content img"));
  console.log("  .reading-content .page-break img", count(".reading-content .page-break img"));
  console.log("  img.wp-manga-chapter-img", count("img.wp-manga-chapter-img"));
  console.log("  div.page-break img     ", count("div.page-break img"));

  // First 3 images from #readerarea (the Themesia/qiscan convention)
  const readerImgs = $("#readerarea img").map((_, el) => {
    const $el = $(el);
    return {
      src: ($el.attr("src") || $el.attr("data-src") || $el.attr("data-lazy-src") || "").trim(),
      cls: $el.attr("class") || "",
    };
  }).get();
  if (readerImgs.length) {
    console.log("\n#readerarea first/last imgs:");
    for (const i of readerImgs.slice(0, 3)) console.log("  ", JSON.stringify(i));
    if (readerImgs.length > 6) console.log("   ...");
    for (const i of readerImgs.slice(-3)) console.log("  ", JSON.stringify(i));
  }

  // Sniff for inline ts_reader / chapter_images JSON
  const inlineScripts = $("script:not([src])").map((_, el) => $(el).html() || "").get();
  const tsReaderHit = inlineScripts.find((s) => s.includes("ts_reader.run("));
  if (tsReaderHit) {
    const idx = tsReaderHit.indexOf("ts_reader.run(");
    console.log("\nts_reader.run snippet (first 300 chars):");
    console.log("  ", tsReaderHit.slice(idx, idx + 300));
  }
  const chImgHit = inlineScripts.find((s) => /chapter_images\s*=/.test(s));
  if (chImgHit) {
    const m = chImgHit.match(/chapter_images\s*=\s*([\s\S]{0,400})/);
    console.log("\nchapter_images snippet:");
    console.log("  ", m?.[1]);
  }
}

summarise("SERIES", SERIES_HTML);
summarise("CHAPTER", CHAPTER_HTML);
