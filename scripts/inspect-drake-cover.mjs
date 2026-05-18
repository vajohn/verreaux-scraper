import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";

const html = readFileSync("/Users/JLAJ9408/Documents/Verreaux/tmp/drake-series.raw.html", "utf8");
const $ = cheerio.load(html);

// Show all candidate cover images on a Themesia series page
const candidates = [
  ".thumb img",
  ".ts-post-image",
  "img.wp-post-image",
  ".series-info img",
  ".bigcontent img",
  ".bigcover img",
  ".infox img",
];
for (const sel of candidates) {
  const $els = $(sel);
  console.log(`\n${sel}  (${$els.length} matches)`);
  $els.slice(0, 3).each((_, el) => {
    const $el = $(el);
    console.log("  ", JSON.stringify({
      src: $el.attr("src"),
      "data-src": $el.attr("data-src"),
      srcset: $el.attr("srcset")?.slice(0, 200),
      alt: $el.attr("alt"),
      class: $el.attr("class"),
      parent: $el.parent().prop("tagName") + "." + $el.parent().attr("class"),
    }));
  });
}

// Print the first ~600 chars around `wp-post-image`
const idx = html.indexOf("wp-post-image");
if (idx >= 0) {
  console.log("\n--- 400 chars around first wp-post-image ---");
  console.log(html.slice(Math.max(0, idx - 200), idx + 600));
}
