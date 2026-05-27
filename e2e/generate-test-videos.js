#!/usr/bin/env node
/*
 * Per-test screenshot videos with metadata banner.
 *
 * Reads frames + meta.json sidecars produced by the per-test capture
 * fixture in `e2e/base.js`, then builds:
 *
 *   test-results/per-test-videos/<safe-test-id>.mp4       (one per test)
 *   test-results/per-test-videos/_combined-local.mp4      (per-bucket concat)
 *   test-results/per-test-videos/_combined-preview.mp4
 *   test-results/per-test-videos/_combined-prod.mp4
 *   test-results/per-test-videos/_combined-other.mp4      (only if non-empty)
 *   test-results/per-test-videos/_combined.txt            (manifest)
 *
 * Layout:
 *   test-results/
 *     per-test-frames/
 *       <safe-test-id>/
 *         0000.png
 *         0001.png
 *         ...
 *         meta.json
 *     per-test-videos/
 *       <safe-test-id>.mp4
 *       _combined-<bucket>.mp4    (one per non-empty bucket)
 *       _combined.txt             (lists each test under its bucket)
 *
 * v2 (PR #143 follow-up): the master `_combined.mp4` is gone. Instead
 * the combined-aggregation stage subdivides the run by target
 * environment ("local" / "preview" / "prod" / "other") so reviewers
 * can scrub one bucket without scrolling through the rest. Per-test
 * mp4 shape is unchanged.
 *
 * Usage:
 *   node e2e/generate-test-videos.js
 *
 * Env:
 *   PR_NUMBER          — PR number to show in the banner (defaults to "local")
 *   FFMPEG             — override path to ffmpeg binary
 *   IMAGEMAGICK        — override path to ImageMagick `convert`
 *   FRAMES_ROOT        — override input dir (defaults to test-results/per-test-frames)
 *   VIDEOS_ROOT        — override output dir (defaults to test-results/per-test-videos)
 *
 * Banner shape (3 monospace lines, 96px black strip ABOVE the screenshot):
 *   1) `PR #<n> · Test <X> of <Y> · <file>::<title>`
 *   2) `Step <x> of <y>: <step name / URL fallback> · <status>`
 *      The URL fallback (when no `test.step()` was active) prefixes the
 *      hostname so the env is unambiguous, e.g. `adamdaniel.ai/admin/`
 *      or `localhost/admin/` (port stripped — it changes per run).
 *   3) `project: <projectName> · <YYYY-MM-DD HH:MM:SS TZ>` (in America/New_York,
 *      with EDT or EST suffix; based on each test's own end time recorded by
 *      the capture fixture)
 *
 * Why per-frame: line 2 changes per frame (Step <x> of <y>, plus the
 * step name pinned to the URL transition that fired *that* frame),
 * so a static ffmpeg `drawtext` filter no longer suffices. We use
 * ImageMagick `convert` to bake the banner+screenshot composite per
 * frame, then ffmpeg concatenates the composites into the per-test
 * mp4. The screenshot pixels themselves are never touched — the
 * banner sits in the padded strip above.
 *
 * Caveats:
 *   - Only the test fixture's primary `page` is captured. Secondary pages
 *     opened via browserContext.newPage() are out of scope for v1.
 *   - The screenshot itself is never overlaid with text or shapes — the
 *     banner sits in a black strip padded above the source image.
 *   - Ordering in the combined video: sort by (file, title, project,
 *     repeatEachIndex). Documented in the _combined.txt manifest.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const FRAMES_ROOT =
  process.env.FRAMES_ROOT || path.join(REPO_ROOT, "test-results", "per-test-frames");
const VIDEOS_ROOT =
  process.env.VIDEOS_ROOT || path.join(REPO_ROOT, "test-results", "per-test-videos");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const IMAGEMAGICK = process.env.IMAGEMAGICK || "convert";

// Frame display rate. 1 frame per 1.5 seconds — slow enough for a
// human to scan, fast enough that a 30-frame test fits in 45s.
const FRAME_RATE = "2/3";

// Banner / canvas geometry. Per-test videos pad each frame to:
//   1920 × (BANNER_HEIGHT + 1080)
// so the concat step can stream-copy without re-encoding.
const BANNER_HEIGHT = 96;
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

// Monospace font baked into the Playwright noble image. LiberationMono
// is a Helvetica-compatible alternative to DejaVuSansMono and is the
// default Ubuntu monospace font.
const MONO_FONT = "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf";

const PR_NUMBER = process.env.PR_NUMBER || "local";

// Banner typography. fontSize × 3 lines + 2 line-spacings must fit in
// BANNER_HEIGHT. With fontSize 22 and lineSpacing 6, total is
// 22*3 + 6*2 = 78px → centered in 96px with 9px top/bottom padding.
const BANNER_FONT_SIZE = 22;
const BANNER_LINE_SPACING = 6;
const BANNER_LEFT_PAD = 20;

// Maximum chars per banner line before we truncate. ~110 was given in
// the spec; LiberationMono at 22pt is ~13.2px wide per char, so 110
// chars ≈ 1452px — comfortably inside 1920 minus the 20px gutter.
const BANNER_MAX_CHARS = 110;

// ── Helpers ─────────────────────────────────────────────────────────

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function listFrameDirs(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    const frames = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}\.png$/.test(f))
      .sort();
    if (frames.length === 0) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      continue;
    }
    out.push({ dir, name, frames, meta });
  }
  return out;
}

function findFontFile() {
  if (fs.existsSync(MONO_FONT)) return MONO_FONT;
  // Best-effort fallback. ImageMagick's font lookup can name-resolve
  // many fonts via fontconfig, but explicit paths are the most
  // portable.
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function detectFontFile() {
  const f = findFontFile();
  if (!f) {
    throw new Error(
      "No monospace TTF font found. Install fonts-liberation (apt) " +
        "or DejaVu Sans Mono and re-run.",
    );
  }
  return f;
}

// Sanitize a banner string. Strip all control chars (incl. NUL/DEL)
// and squeeze whitespace, then truncate. ImageMagick's `-annotate`
// reads the value as a single string; embedded newlines or NULs
// would terminate the option early.
function sanitizeBannerText(s, maxChars = BANNER_MAX_CHARS) {
  const cleaned = String(s == null ? "" : s)
    .replace(/[\x00-\x1f\x7f]+/g, " ") // eslint-disable-line no-control-regex
    .replace(/\s{2,}/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  // Truncate with an ellipsis-equivalent. Use plain "…" since the
  // font ships with U+2026 in its Latin coverage.
  return cleaned.slice(0, maxChars - 1) + "…";
}

// Format a date in America/New_York (EDT / EST) as
// `YYYY-MM-DD HH:MM:SS TZ`. Uses Intl.DateTimeFormat with timeZone +
// timeZoneName; the Playwright noble image has full ICU baked in
// (verified at startup).
function formatEastern(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "unknown-time";
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : "";
  };
  // Intl with hour12: false occasionally emits "24" for midnight on
  // some platforms; normalise.
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

// Pull a "step name / URL fallback" string for a single frame. If
// the capture fixture recorded a `stepTitle`, use it; otherwise fall
// back to the URL's host+pathname so the banner still has something
// human-meaningful instead of an ambiguous bare path.
//
// URL-fallback rendering rules (no stepTitle):
//   - `localhost` and `127.0.0.1` (any port): host is rendered as
//     `localhost` (port stripped — it changes per run and adds noise)
//     followed by the pathname, e.g.
//     `http://localhost:4000/admin/` → `localhost/admin/`.
//   - Any other hostname: rendered as `<host><pathname>`, e.g.
//     `https://adamdaniel.ai/admin/` → `adamdaniel.ai/admin/`. Dropping
//     the host here would render `/admin/` ambiguously.
//   - `about:blank` is left alone (no host to extract).
//   - `data:` / `blob:` URLs are truncated to the first ~32 chars + `…`
//     so the banner doesn't blow up from a multi-kB inline payload.
//
// When a stepTitle is present we never prefix it with the hostname —
// the step author chose the title and we respect it verbatim.
const URL_FALLBACK_DATA_BLOB_PREFIX_LEN = 32;

function frameStepLabel(frame) {
  const t = frame && frame.stepTitle;
  if (t && String(t).trim().length > 0) return String(t);
  const url = frame && frame.url;
  if (!url) return "(no navigation)";
  // about:blank — render as-is, no host extraction.
  if (url === "about:blank") return "about:blank";
  // data: / blob: — opaque payloads, just show a truncated prefix.
  if (/^(data|blob):/i.test(url)) {
    if (url.length <= URL_FALLBACK_DATA_BLOB_PREFIX_LEN) return url;
    return url.slice(0, URL_FALLBACK_DATA_BLOB_PREFIX_LEN) + "…";
  }
  try {
    const u = new URL(url);
    // Always render hostname-only (no port). For localhost the port
    // is the one piece of noise that changes per run (Jekyll picks 4000,
    // CI may pick something else); dropping it keeps banners stable
    // across reruns. For prod-style hosts there's no port anyway. We
    // always render hostname-only because a bare `/admin/` is
    // ambiguous about which environment is being exercised.
    const hostname = u.hostname || "";
    const path_ = u.pathname || "/";
    return hostname + path_ + (u.search || "");
  } catch {
    // Non-parseable URL (unusual but possible for malformed inputs).
    return String(url);
  }
}

// ── Bucketing by target environment ────────────────────────────────
//
// A CI run today produces a single `_combined.mp4` master that
// concatenates every per-test video. With dozens of tests across
// localhost-fake-backend, preview-PR, and prod targets, scrubbing
// for "all the local-fake-backend tests" means scrolling past the
// rest. Instead, subdivide the combined stream by target environment
// so reviewers can pull just the bucket they care about.
//
// Buckets (precedence — first match wins):
//   1. `local`   — host is `localhost` or `127.0.0.1`
//                  (regardless of port).
//   2. `preview` — host matches `^preview-pr\d+\.adamdaniel\.ai$`.
//   3. `prod`    — host is exactly `adamdaniel.ai` (apex; no
//                  subdomain, since `preview-pr*` is its own bucket).
//   4. `other`   — catch-all (about:blank, data:/blob:, third-party
//                  hosts, malformed URLs).
//
// Per-test bucket assignment uses the FIRST captured frame's host.
// One rule beats per-frame fragmentation; tests that traverse hosts
// are rare and the first navigation typically identifies the harness
// (e.g. a localhost smoke that pops out to GitHub OAuth still belongs
// in `local`). The `_combined.txt` manifest records each test's
// assigned bucket so reviewers can sanity-check the mapping.
const BUCKETS = ["local", "preview", "prod", "other"];

function bucketFor(host) {
  if (host === "localhost" || host === "127.0.0.1") return "local";
  if (typeof host === "string" && /^preview-pr\d+\.adamdaniel\.ai$/.test(host)) {
    return "preview";
  }
  if (host === "adamdaniel.ai") return "prod";
  return "other";
}

// Pull the host (no port) from a URL string. Returns "" for inputs
// without an extractable hostname (about:blank, data:, blob:, malformed).
function hostFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  if (url === "about:blank") return "";
  if (/^(data|blob):/i.test(url)) return "";
  try {
    const u = new URL(url);
    return u.hostname || "";
  } catch {
    return "";
  }
}

// Resolve a per-test bucket from its meta record. Looks at the FIRST
// captured frame's URL; tests with no frames (zero-navigation specs)
// fall through to `other`.
function bucketForEntry(entry) {
  const frames = entry && entry.meta && Array.isArray(entry.meta.frames) ? entry.meta.frames : [];
  const firstUrl = frames.length > 0 ? frames[0].url : "";
  return bucketFor(hostFromUrl(firstUrl));
}

// Build the three banner lines for a single frame. Pure: no env or
// disk IO. Centralised so the test suite can assert the exact shape.
function buildFrameBannerLines({
  prNumber,
  testIndex,
  testCount,
  file,
  title,
  stepIndex,
  stepCount,
  stepLabel,
  status,
  projectName,
  endTime,
}) {
  const line1 = sanitizeBannerText(
    `PR #${prNumber} · Test ${testIndex} of ${testCount} · ${file || "unknown"}::${title || "untitled"}`,
  );
  const line2 = sanitizeBannerText(
    `Step ${stepIndex} of ${stepCount}: ${stepLabel} · ${status || "unknown"}`,
  );
  const easternTime = formatEastern(
    endTime instanceof Date ? endTime : endTime ? new Date(endTime) : new Date(),
  );
  const line3 = sanitizeBannerText(`project: ${projectName || "unknown-project"} · ${easternTime}`);
  return [line1, line2, line3];
}

// ── External tools ──────────────────────────────────────────────────

function runFfmpeg(args, opts = {}) {
  const result = spawnSync(FFMPEG, args, {
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const tail = (result.stderr || "").split("\n").slice(-30).join("\n");
    throw new Error(`ffmpeg failed (exit ${result.status}):\n  args: ${args.join(" ")}\n${tail}`);
  }
  return result;
}

function runConvert(args) {
  const result = spawnSync(IMAGEMAGICK, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const tail = (result.stderr || "").split("\n").slice(-30).join("\n");
    throw new Error(`convert failed (exit ${result.status}):\n  args: ${args.join(" ")}\n${tail}`);
  }
  return result;
}

function checkConvertAvailable() {
  const r = spawnSync(IMAGEMAGICK, ["-version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `ImageMagick \`convert\` not found at "${IMAGEMAGICK}". Install ` +
        "the `imagemagick` apt package (already pinned in the e2e " +
        "finalize job) or set the IMAGEMAGICK env var.",
    );
  }
}

// Compose a single frame: scale-down-only the source PNG to fit
// CANVAS_WIDTH×CANVAS_HEIGHT, paint a black 96px banner above, and
// draw the three sanitized banner lines. Output is exactly
// CANVAS_WIDTH×TOTAL_HEIGHT pixels so the per-test mp4 has uniform
// dimensions and the master concat step works with `-c copy`.
//
// Two-step pipeline (one `convert` invocation):
//   1) Generate the 96px black banner with three white text lines as
//      a "label:" sub-image.
//   2) Stack the banner on top of the rescaled source via `-append`.
//
// This avoids an ImageMagick quirk where `-annotate` after `-splice`
// applies a vertical offset that shifts all text down by ~19px,
// pushing line 3 off the bottom of the banner. Building the banner
// against a fresh empty canvas (size + xc:black) and then using
// `-append` to stack keeps the y math exactly as the human would
// expect.
function composeFrame({ inputFrame, outputFrame, fontFile, lines }) {
  // Vertical layout: text baseline ascender ≈ pointsize - 4. For
  // pointsize 22, cap top sits at baseline-15 and descenders fall
  // ~4px below baseline. Centering N lines in BANNER_HEIGHT:
  //   total = N*pointsize + (N-1)*spacing
  //   topPad = (banner - total) / 2
  // We position each line's baseline at:
  //   topPad + (i+1)*pointsize + i*spacing
  const N = lines.length;
  const totalLineHeight = N * BANNER_FONT_SIZE + (N - 1) * BANNER_LINE_SPACING;
  const topPad = Math.max(4, Math.floor((BANNER_HEIGHT - totalLineHeight) / 2));

  // Build two convert sub-commands chained via the parenthesis
  // syntax (`(` `)` ImageMagick image stack). The first parenthesised
  // block creates the banner: a `xc:black` of (CANVAS_WIDTH x
  // BANNER_HEIGHT), with three -annotate calls drawing each line at
  // its computed baseline. The second block reads the source frame,
  // scales+pads to the canvas. Then `-append` stacks them vertically
  // (banner on top because it was first on the stack).
  const args = [
    // ── Banner image (built first, ends up on top after -append) ──
    "(",
    "-size",
    `${CANVAS_WIDTH}x${BANNER_HEIGHT}`,
    "xc:black",
    "-font",
    fontFile,
    "-pointsize",
    String(BANNER_FONT_SIZE),
    "-fill",
    "white",
  ];
  for (let i = 0; i < lines.length; i++) {
    const y = topPad + (i + 1) * BANNER_FONT_SIZE + i * BANNER_LINE_SPACING;
    args.push("-annotate", `+${BANNER_LEFT_PAD}+${y}`, lines[i]);
  }
  args.push(")");
  // ── Source image (scaled + padded to CANVAS_WIDTH × CANVAS_HEIGHT) ──
  args.push(
    "(",
    inputFrame,
    "-background",
    "black",
    "-gravity",
    "center",
    "-resize",
    `${CANVAS_WIDTH}x${CANVAS_HEIGHT}>`,
    "-extent",
    `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
    ")",
  );
  // Stack: banner on top (the first parenthesised sub-image).
  args.push("-append", outputFrame);
  runConvert(args);
}

// ── Per-test video build ────────────────────────────────────────────

function buildPerTestVideo({ entry, fontFile, testIndex, testCount, prNumber }) {
  const { dir, frames, meta } = entry;
  const safeId = entry.name;
  const outputPath = path.join(VIDEOS_ROOT, `${safeId}.mp4`);

  const frameCount = frames.length;
  const status = meta.status || "unknown";
  const file = meta.file || "unknown";
  const title = meta.title || "untitled";
  const projectName = meta.projectName || "unknown-project";
  const endTime = meta.endTime ? new Date(meta.endTime) : new Date();

  // Pre-render each frame's banner+composite to a per-test temp dir.
  const tmpDir = path.join(VIDEOS_ROOT, ".tmp", safeId);
  ensureDir(tmpDir);

  // The capture fixture records `meta.frames[]` aligned 1:1 with the
  // NNNN.png on disk. If the meta got out of sync (frame written but
  // capture record dropped due to navigation race), use the URL/step
  // fallback `(no navigation)` so the slot still has a label.
  const metaFrames = Array.isArray(meta.frames) ? meta.frames : [];
  const composites = [];
  for (let i = 0; i < frames.length; i++) {
    const inputFrame = path.join(dir, frames[i]);
    const compositeName = `composite-${String(i).padStart(4, "0")}.png`;
    const outputFrame = path.join(tmpDir, compositeName);
    const frameMeta = metaFrames[i] || null;
    const stepLabel = frameStepLabel(frameMeta);
    const lines = buildFrameBannerLines({
      prNumber,
      testIndex,
      testCount,
      file,
      title,
      stepIndex: i + 1,
      stepCount: frameCount,
      stepLabel,
      status,
      projectName,
      endTime,
    });
    composeFrame({ inputFrame, outputFrame, fontFile, lines });
    composites.push(outputFrame);
  }

  // Ask ffmpeg to read the composites as an image2 sequence. The
  // tmpDir's filenames are zero-padded `composite-NNNN.png`, so we
  // pass an exact pattern.
  const inputPattern = path.join(tmpDir, "composite-%04d.png");
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    FRAME_RATE,
    "-i",
    inputPattern,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  runFfmpeg(args);

  // Cleanup: drop composites + tmpDir.
  for (const f of composites) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch {
    /* ignore */
  }

  return outputPath;
}

// Concat a list of per-test mp4 paths into a single output mp4. Used
// once per non-empty bucket. Stream-copies because every per-test video
// already shares the same canvas, codec, and pixel format. Returns the
// output path on success, throws on failure.
function concatPerTestVideos(perTestPaths, output, tag) {
  if (perTestPaths.length === 0) return null;
  const concatList = path.join(VIDEOS_ROOT, ".tmp", `concat-${tag || "all"}.txt`);
  ensureDir(path.dirname(concatList));
  const lines = perTestPaths.map((p) => {
    // ffmpeg concat demuxer requires single-quoted paths and only
    // handles literal paths (no globs). Escape embedded quotes.
    const escaped = p.replace(/'/g, "'\\''");
    return `file '${escaped}'`;
  });
  fs.writeFileSync(concatList, lines.join("\n") + "\n");

  // Stream-copy concat — every per-test video uses the same canvas,
  // codec (libx264), profile, and pixel format, so this works without
  // re-encoding.
  runFfmpeg([
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);

  try {
    fs.unlinkSync(concatList);
  } catch {
    /* ignore */
  }
  return output;
}

// Build per-bucket combined videos from a list of {entry, perTestPath}
// records. Each non-empty bucket emits `_combined-<bucket>.mp4`.
// Empty buckets are silently skipped (no point in a 0-byte file).
// Returns a map { bucket → outputPath } for the buckets that emitted.
function buildBucketedCombinedVideos(records) {
  /** @type {Record<string, string[]>} */
  const byBucket = {};
  for (const b of BUCKETS) byBucket[b] = [];
  for (const r of records) {
    const b = r.bucket;
    if (!byBucket[b]) byBucket[b] = [];
    byBucket[b].push(r.perTestPath);
  }

  const emitted = {};
  for (const bucket of BUCKETS) {
    const list = byBucket[bucket];
    if (!list || list.length === 0) {
      console.log(`Bucket ${bucket}: 0 tests — skipping combined video.`);
      continue;
    }
    const output = path.join(VIDEOS_ROOT, `_combined-${bucket}.mp4`);
    concatPerTestVideos(list, output, bucket);
    emitted[bucket] = output;
  }

  // Cleanup empty .tmp dir if it's no longer needed.
  try {
    fs.rmdirSync(path.join(VIDEOS_ROOT, ".tmp"));
  } catch {
    /* ignore — only succeeds when empty */
  }
  return emitted;
}

function writeManifest(records, prNumber, emittedBuckets) {
  const manifest = path.join(VIDEOS_ROOT, "_combined.txt");
  const Y = records.length;
  // Group rows by bucket so the manifest reads as a stack of bucket
  // sections. Within a bucket, records were already sorted by
  // (file, title, project, repeatEachIndex) before bucket assignment.
  /** @type {Record<string, typeof records>} */
  const byBucket = {};
  for (const b of BUCKETS) byBucket[b] = [];
  for (const r of records) byBucket[r.bucket].push(r);

  const sections = [];
  for (const bucket of BUCKETS) {
    const list = byBucket[bucket];
    const bucketOutput = emittedBuckets[bucket];
    const head = bucketOutput
      ? `Bucket ${bucket} → ${path.basename(bucketOutput)} (${list.length} test${list.length === 1 ? "" : "s"})`
      : `Bucket ${bucket} → (empty — no combined video emitted)`;
    if (list.length === 0) {
      sections.push(head);
      continue;
    }
    const rows = list.map((r, i) => {
      const meta = r.entry.meta;
      const endLocal = meta.endTime ? formatEastern(new Date(meta.endTime)) : "";
      return [
        `  [${bucket} ${i + 1} of ${list.length}] ${path.basename(r.perTestPath)}`,
        `      file:    ${meta.file || ""}`,
        `      title:   ${meta.title || ""}`,
        `      project: ${meta.projectName || ""}`,
        `      repeat:  ${meta.repeatEachIndex || 0}`,
        `      status:  ${meta.status || ""}`,
        `      frames:  ${r.entry.frames.length}`,
        `      end:     ${endLocal}`,
      ].join("\n");
    });
    sections.push(head + "\n" + rows.join("\n\n"));
  }

  const header = [
    "Per-test screenshot videos — manifest",
    `PR:        #${prNumber}`,
    `Tests:     ${Y}`,
    `Order:     (file, title, project, repeatEachIndex) within each bucket`,
    `Buckets:   local | preview | prod | other (assigned by FIRST frame's host)`,
    "",
  ].join("\n");
  fs.writeFileSync(manifest, header + sections.join("\n\n") + "\n");
  return manifest;
}

function compareEntries(a, b) {
  const ma = a.meta;
  const mb = b.meta;
  return (
    String(ma.file || "").localeCompare(mb.file || "") ||
    String(ma.title || "").localeCompare(mb.title || "") ||
    String(ma.projectName || "").localeCompare(mb.projectName || "") ||
    (ma.repeatEachIndex || 0) - (mb.repeatEachIndex || 0)
  );
}

function main() {
  if (!fs.existsSync(FRAMES_ROOT)) {
    console.error(`No frames root at ${FRAMES_ROOT} — nothing to do.`);
    return 0;
  }
  ensureDir(VIDEOS_ROOT);

  let entries = listFrameDirs(FRAMES_ROOT);
  if (entries.length === 0) {
    console.error(
      `No per-test frame directories found under ${FRAMES_ROOT}. Did the` +
        ` capture fixture run? (See e2e/base.js.)`,
    );
    return 0;
  }
  entries.sort(compareEntries);

  const fontFile = detectFontFile();
  checkConvertAvailable();
  const Y = entries.length;
  console.log(`Generating ${Y} per-test video(s) → ${path.relative(REPO_ROOT, VIDEOS_ROOT)}/`);
  console.log(`  font:      ${fontFile}`);
  console.log(`  PR:        #${PR_NUMBER}`);
  console.log(`  convert:   ${IMAGEMAGICK}`);
  console.log(`  ffmpeg:    ${FFMPEG}`);

  const perTestPaths = [];
  let succeeded = 0;
  let failed = 0;
  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const testIndex = idx + 1; // 1-indexed for the banner
    const label = `${entry.meta.projectName || "?"} / ${entry.meta.file || "?"} / ${entry.meta.title || "?"}`;
    try {
      const out = buildPerTestVideo({
        entry,
        fontFile,
        testIndex,
        testCount: Y,
        prNumber: PR_NUMBER,
      });
      perTestPaths.push(out);
      succeeded += 1;
      console.log(`  ok   [Test ${testIndex} of ${Y}, ${entry.frames.length} frames] ${label}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${label}: ${err.message}`);
    }
  }

  if (perTestPaths.length === 0) {
    console.error("No per-test videos produced; skipping concat.");
    return failed > 0 ? 1 : 0;
  }

  // Build per-test records carrying their bucket assignment. Each
  // entry's bucket is the bucket of its FIRST captured frame's host
  // (see bucketForEntry / bucketFor for precedence + edge cases).
  const records = [];
  for (let idx = 0; idx < entries.length; idx++) {
    if (!perTestPaths[idx]) continue;
    const entry = entries[idx];
    const bucket = bucketForEntry(entry);
    records.push({ entry, perTestPath: perTestPaths[idx], bucket });
  }

  let emittedBuckets = {};
  try {
    emittedBuckets = buildBucketedCombinedVideos(records);
    const emittedNames = Object.keys(emittedBuckets);
    if (emittedNames.length === 0) {
      console.log("No bucket emitted a combined video.");
    } else {
      for (const b of emittedNames) {
        console.log(`Combined video → ${path.relative(REPO_ROOT, emittedBuckets[b])}`);
      }
    }
  } catch (err) {
    console.error(`Bucketed combined videos failed: ${err.message}`);
    failed += 1;
  }

  try {
    const manifest = writeManifest(records, PR_NUMBER, emittedBuckets);
    console.log(`Manifest → ${path.relative(REPO_ROOT, manifest)}`);
  } catch (err) {
    console.error(`Manifest write failed: ${err.message}`);
  }

  console.log(`Done. ${succeeded} per-test video(s) built, ${failed} failure(s).`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  buildBucketedCombinedVideos,
  buildFrameBannerLines,
  bucketFor,
  bucketForEntry,
  compareEntries,
  formatEastern,
  frameStepLabel,
  hostFromUrl,
  listFrameDirs,
  sanitizeBannerText,
  writeManifest,
  BANNER_MAX_CHARS,
  BUCKETS,
};
