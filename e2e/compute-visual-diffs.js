#!/usr/bin/env node
//
// Compute the *actual* visual diff between PR-side and PROD-side
// regression screenshots. The detect-changed-pages.js heuristic flags
// pages that the changeset *could* affect (any _layouts/_includes/
// _config.yml edit fans out to every page); reviewers then need to
// know which of those pages actually look different. This script
// produces that signal — a per-page status plus aggregate totals —
// and persists it next to the comparison video so the bot comment,
// the reviews dashboard, and the video itself can all label pages
// consistently.
//
// Output (e.g. screenshots/regression/diffs.json):
//
//   {
//     "totals": {
//       "identical": 8, "different": 2, "new": 1,
//       "visuallyDifferent": 3,        // different + new (incl. text-escalated)
//       "textChanged": 1,              // pages whose visible text changed
//       "potentiallyAffected": 10      // == page-changes.json.changed.length
//     },
//     "pages": [
//       { "path": "/", "status": "identical", "diffRatio": 0 },
//       { "path": "/blog/foo/", "status": "different", "diffRatio": 0.183 },
//       { "path": "/pages/x/", "status": "different", "diffRatio": 0.0001,
//         "textChanged": true, "textDiff": { "prod": "…", "pr": "…" } },
//       { "path": "/projects/bar/", "status": "new", "diffRatio": null }
//     ]
//   }
//
// Besides the PNGs, the spec drops a `<safe>.txt` visible-text dump per
// side and a `prod-missing.json` list of pages prod answered 404/410 for.
// Text is compared whitespace-normalized; a text change on a real page
// ESCALATES an "identical" pixel status to "different" — a text delta is
// human-meaningful no matter how few pixels it moves (the sub-threshold
// nav-link case), and unlike the viewport screenshot it also covers
// below-the-fold content. A missing text dump on either side skips the
// text check (same tolerance rationale as "no-baseline" below).
// `prod-missing.json` pages score as "new" (→ review gate): an HTTP 404
// is prod CONFIRMING absence, unlike a missing PNG which may just be a
// transient capture gap.

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

// Allow per-channel anti-aliasing noise up to this magnitude (0–255)
// before counting a pixel as "different". Empirically, anti-aliasing
// produces 1–6 unit deltas; 10 is comfortably above that.
const PER_CHANNEL_TOLERANCE = 10;

// A page is "visually different" when more than this fraction of its
// pixels exceed the per-channel tolerance. Chosen to absorb anti-
// aliasing noise on font rendering while still flagging anything
// human-noticeable. Tighten if the dashboard produces false negatives.
const RATIO_THRESHOLD = 0.005; // 0.5%

function safeFileName(pagePath) {
  const name = pagePath.replace(/\//g, "_").replace(/^_/, "").replace(/_$/, "");
  return name || "index";
}

/**
 * Returns the fraction of pixels in `a` and `b` that differ beyond
 * PER_CHANNEL_TOLERANCE on any channel. Returns NaN if the images
 * are different sizes (caller treats that as "different").
 */
function pixelDiffRatio(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Number.NaN;
  const total = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i + 0] - b.data[i + 0]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (dr > PER_CHANNEL_TOLERANCE || dg > PER_CHANNEL_TOLERANCE || db > PER_CHANNEL_TOLERANCE) {
      diff++;
    }
  }
  return diff / total;
}

function classifyDiff(ratio) {
  if (!Number.isFinite(ratio)) return "different";
  return ratio > RATIO_THRESHOLD ? "different" : "identical";
}

function readPNG(file) {
  if (!fs.existsSync(file)) return null;
  return PNG.sync.read(fs.readFileSync(file));
}

function normalizeText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Short excerpt around the first divergence of two normalized text dumps,
// for the PR comment — enough to see WHAT changed without dumping pages.
function firstTextDivergence(prodText, prText, context = 60) {
  let i = 0;
  const max = Math.min(prodText.length, prText.length);
  while (i < max && prodText[i] === prText[i]) i++;
  const start = Math.max(0, i - Math.floor(context / 3));
  const clip = (s) => {
    const seg = s.slice(start, i + context);
    return `${start > 0 ? "…" : ""}${seg}${i + context < s.length ? "…" : ""}`;
  };
  return { prod: clip(prodText), pr: clip(prText) };
}

// Compares the two sides' visible-text dumps for a page. Returns null when
// either dump is absent (placeholder sides, capture gaps — tolerated) or
// the normalized text matches; otherwise { prod, pr } excerpts.
function textDiffFor(prDir, prodDir, safe) {
  const prFile = path.join(prDir, `${safe}.txt`);
  const prodFile = path.join(prodDir, `${safe}.txt`);
  if (!fs.existsSync(prFile) || !fs.existsSync(prodFile)) return null;
  const prod = normalizeText(fs.readFileSync(prodFile, "utf8"));
  const pr = normalizeText(fs.readFileSync(prFile, "utf8"));
  if (prod === pr) return null;
  return firstTextDivergence(prod, pr);
}

function computeAll({ changesPath, prDir, prodDir, outPath }) {
  const changes = JSON.parse(fs.readFileSync(changesPath, "utf8"));
  const newSet = new Set(changes.new || []);
  const all = [...(changes.changed || []), ...(changes.new || []), ...(changes.unchanged || [])];

  // Pages prod answered 404/410 for at capture time (written by
  // regression-video.spec.js next to the pr/ and prod/ dirs). These are
  // CONFIRMED-new regardless of what the changed-file mapper knew.
  let prodMissing = new Set();
  try {
    prodMissing = new Set(JSON.parse(fs.readFileSync(path.resolve(prDir, "..", "prod-missing.json"), "utf8")));
  } catch {
    prodMissing = new Set();
  }

  const pages = [];
  let identical = 0;
  let different = 0;
  let neu = 0;
  let textChangedCount = 0;

  for (const p of all) {
    const safe = safeFileName(p);
    const prFile = path.join(prDir, `${safe}.png`);
    const prodFile = path.join(prodDir, `${safe}.png`);

    if (newSet.has(p) || prodMissing.has(p)) {
      pages.push({ path: p, status: "new", diffRatio: null });
      neu++;
      continue;
    }

    const prImg = readPNG(prFile);
    const prodImg = readPNG(prodFile);

    if (!prodImg) {
      // No PRODUCTION baseline for a page flagged changed/unchanged: either
      // it's new to prod or the prod screenshot was unavailable this run (a
      // transient capture gap — the class that left #1858 stuck). We cannot
      // diff, so we must NOT score it as a regression: doing so would force
      // the manual `regression-review` gate and deadlock a REQUIRED check on
      // something that isn't a confirmed visual change. Treated like "new":
      // recorded, but excluded from the visually-different count.
      pages.push({ path: p, status: "no-baseline", diffRatio: null });
      continue;
    }

    if (!prImg) {
      // PR-side screenshot missing for a page that DOES exist in prod — a
      // real signal the PR may have broken the page; flag it for review.
      pages.push({ path: p, status: "different", diffRatio: null });
      different++;
      continue;
    }

    const ratio = pixelDiffRatio(prImg, prodImg);
    let status = classifyDiff(ratio);

    // Text check: a visible-text delta escalates a pixel-"identical" page —
    // it's human-meaningful however few pixels it moves, and covers
    // below-the-fold content the viewport screenshot can't see.
    const textDiff = textDiffFor(prDir, prodDir, safe);
    if (textDiff && status === "identical") status = "different";

    pages.push({
      path: p,
      status,
      diffRatio: Number.isFinite(ratio) ? Number(ratio.toFixed(6)) : null,
      ...(textDiff ? { textChanged: true, textDiff } : {}),
    });
    if (textDiff) textChangedCount++;
    if (status === "different") different++;
    else identical++;
  }

  const summary = {
    totals: {
      identical,
      different,
      new: neu,
      visuallyDifferent: different + neu,
      textChanged: textChangedCount,
      potentiallyAffected: (changes.changed || []).length,
    },
    pages,
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  }
  return summary;
}

module.exports = {
  pixelDiffRatio,
  classifyDiff,
  computeAll,
  safeFileName,
  normalizeText,
  firstTextDivergence,
  PER_CHANNEL_TOLERANCE,
  RATIO_THRESHOLD,
};

if (require.main === module) {
  const [, , changesPath, prDir, prodDir, outPath] = process.argv;
  if (!changesPath || !prDir || !prodDir || !outPath) {
    console.error("usage: compute-visual-diffs.js <changes.json> <pr-dir> <prod-dir> <out.json>");
    process.exit(2);
  }
  const summary = computeAll({ changesPath, prDir, prodDir, outPath });
  console.log(
    `wrote ${outPath} — ${summary.totals.visuallyDifferent}/${summary.pages.length} pages visually different`,
  );
}
