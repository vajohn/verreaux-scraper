// Confirm the arenascan/Themesia parsers (which we'll port to drake) accept the
// drake fixtures without modification.
import { readFileSync } from "node:fs";
import {
  parseSeriesMetadata,
  parseChapterList,
  extractTsReaderConfig,
  pickImageList,
} from "../dist/adapters/arenascan.helpers.js";

const series = readFileSync("/Users/JLAJ9408/Documents/Verreaux/tmp/drake-series.raw.html", "utf8");
const chapter = readFileSync("/Users/JLAJ9408/Documents/Verreaux/tmp/drake-chapter.raw.html", "utf8");

const meta = parseSeriesMetadata(series);
console.log("series meta:", meta);

const chapters = parseChapterList(series, "https://drakecomic.org");
console.log("chapters parsed:", chapters.length, "first:", chapters[0], "last:", chapters.at(-1));

const cfg = extractTsReaderConfig(chapter);
console.log("ts_reader post_id:", cfg?.post_id, "sources:", cfg?.sources?.map((s) => ({ source: s.source, n: s.images.length })));

const imgs = cfg ? pickImageList(cfg) : [];
console.log("images:", imgs.length, "\n  first:", imgs[0], "\n  last:", imgs.at(-1));
