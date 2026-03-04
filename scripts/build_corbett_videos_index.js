import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where to save the output JSON (adjust if you prefer a different location)
const OUT_PATH = path.join(__dirname, "..", "CCA", "Maths", "Yr9", "resources", "corbett_videos.json");

// Page to scrape (Corbett Maths videos index)
const START_URL = "https://corbettmaths.com/contents/";

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (CurriculumCompanion; +https://example.local)",
      "Accept": "text/html,*/*",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

function normaliseText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || "";
    const clean = slug
      .replace(/-\d+$/, "")           // remove trailing "-2" etc
      .replace(/\bvideo\b/gi, "")     // remove word "video"
      .replace(/[-_]+/g, " ")         // slug to spaces
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return "";
    return clean.replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
  } catch {
    return "";
  }
}

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.url) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}
async function urlIsLive(url) {
  // Prefer HEAD (fast). If blocked, fall back to GET.
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (head.ok) return true;
    // Some servers return 405 for HEAD
    if (head.status === 405) {
      const get = await fetch(url, { method: "GET", redirect: "follow" });
      return get.ok;
    }
    return false;
  } catch {
    return false;
  }
}

async function filterLiveUrls(items, concurrency = 15) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const it = items[idx];
      const ok = await urlIsLive(it.url);
      if (ok) results.push(it);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(`Fetching: ${START_URL}`);
  const html = await fetchHtml(START_URL);
  const $ = cheerio.load(html);

  // Heuristic: collect all links on the page that look like topic video pages
  // Corbett structure can change; we’ll capture a broad set and filter lightly.
  const items = [];
  $("a").each((_, a) => {
    const href = $(a).attr("href");
    const text = normaliseText($(a).text());
    if (!href) return;

    // Build absolute URL
    let url;
    try {
      url = new URL(href, START_URL).toString();
    } catch {
      return;
    }

    // Only keep corbettmaths.com links
    if (!url.includes("corbettmaths.com")) return;
    if (url.includes("#")) return;

    // We only want actual video pages, not the index itself or category anchors
    // Corbett content pages are typically blog-style posts (year/month/day) or topic pages.
    const looksLikeVideoPage =
      /\/\d{4}\/\d{2}\/\d{2}\//.test(url) || /-video/i.test(url) || /video/i.test(text);

    if (!looksLikeVideoPage) return;

    // Improve titles when link text is generic ("Video 1", "Video 2", etc.)
    const genericText = /^video\s*\d+$/i.test(text) || text.toLowerCase() === "video";
    const betterTitle = genericText ? titleFromUrl(url) : text;

    items.push({
      title: betterTitle || text || titleFromUrl(url) || "Untitled",
      url,
      source: "corbettmaths_videos_index",
    });
  });

const deduped = dedupeByUrl(items);

console.log(`Checking ${deduped.length} URLs for 200–399 responses (this may take a minute)...`);
const liveOnly = await filterLiveUrls(deduped, 15);

console.log(`Live URLs kept: ${liveOnly.length} / ${deduped.length}`);

  // Save
  ensureDirExists(OUT_PATH);
  fs.writeFileSync(OUT_PATH, JSON.stringify(liveOnly, null, 2), "utf8");

console.log(`Saved ${liveOnly.length} entries to: ${OUT_PATH}`);
console.log("Sample:", liveOnly.slice(0, 5));
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
