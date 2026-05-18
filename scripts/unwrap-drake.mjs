// Chrome's view-source: pages wrap the actual source in <td class="line-content">
// rows. Extract real HTML by joining the text content of those rows.
import { readFileSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";

for (const [src, dst] of [
  ["/Users/JLAJ9408/Documents/Verreaux/tmp/drake-series.html",
   "/Users/JLAJ9408/Documents/Verreaux/tmp/drake-series.raw.html"],
  ["/Users/JLAJ9408/Documents/Verreaux/tmp/drake-chapter.html",
   "/Users/JLAJ9408/Documents/Verreaux/tmp/drake-chapter.raw.html"],
]) {
  const wrapper = readFileSync(src, "utf8");
  const $ = cheerio.load(wrapper);
  const rows = $("td.line-content").map((_, el) => $(el).text()).get();
  const out = rows.join("\n");
  writeFileSync(dst, out, "utf8");
  console.log(`${src}\n  rows=${rows.length}  bytes=${out.length} -> ${dst}`);
}
