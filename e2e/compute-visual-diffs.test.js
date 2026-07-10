// @lane: local — pure-fs unit tests for the visual-diff PNG comparison helper
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const { PNG } = require("pngjs");

const {
  pixelDiffRatio,
  classifyDiff,
  computeAll,
  safeFileName,
} = require("./compute-visual-diffs");

// Pure unit tests for the visual-diff classification. Runs in any
// project (no browser needed) — Playwright launches it just because
// the file matches testDir, but the work is plain Node + pngjs.

function makePNG(width, height, fill /* [r,g,b,a] */) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = fill[0];
    png.data[i + 1] = fill[1];
    png.data[i + 2] = fill[2];
    png.data[i + 3] = fill[3];
  }
  return png;
}

function writePNG(png, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

test.describe("compute-visual-diffs", () => {
  test("pixelDiffRatio: identical images report 0", () => {
    const a = makePNG(20, 20, [255, 255, 255, 255]);
    const b = makePNG(20, 20, [255, 255, 255, 255]);
    expect(pixelDiffRatio(a, b)).toBe(0);
  });

  test("pixelDiffRatio: 50% of pixels differ → ratio ≈ 0.5", () => {
    const w = 10,
      h = 10;
    const a = makePNG(w, h, [0, 0, 0, 255]);
    const b = makePNG(w, h, [0, 0, 0, 255]);
    // Flip half the pixels in `b` to white.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w / 2; x++) {
        const i = (y * w + x) * 4;
        b.data[i + 0] = 255;
        b.data[i + 1] = 255;
        b.data[i + 2] = 255;
      }
    }
    expect(pixelDiffRatio(a, b)).toBeCloseTo(0.5, 2);
  });

  test("pixelDiffRatio: tiny channel-level deltas are absorbed by tolerance", () => {
    // Anti-aliasing noise: every pixel off by 5 on every channel — no
    // human would call this 'different', and the threshold should treat
    // it as 0.
    const a = makePNG(20, 20, [100, 100, 100, 255]);
    const b = makePNG(20, 20, [105, 102, 103, 255]);
    expect(pixelDiffRatio(a, b)).toBe(0);
  });

  test("classifyDiff: 0% → identical; 0.4% → identical; 1% → different", () => {
    expect(classifyDiff(0)).toBe("identical");
    expect(classifyDiff(0.004)).toBe("identical");
    expect(classifyDiff(0.01)).toBe("different");
    expect(classifyDiff(0.5)).toBe("different");
  });

  test("classifyDiff: NaN (missing image / mismatched size) → different", () => {
    expect(classifyDiff(Number.NaN)).toBe("different");
  });

  test("computeAll: writes a per-page summary JSON", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regdiff-"));
    const prDir = path.join(tmp, "pr");
    const prodDir = path.join(tmp, "prod");

    const changes = {
      changed: ["/blog/post-a/", "/blog/post-b/"],
      new: ["/blog/post-c/"],
      unchanged: [],
    };

    // Same → identical
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/blog/post-a/")}.png`);
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prodDir, `${safeFileName("/blog/post-a/")}.png`);

    // Different → different
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/blog/post-b/")}.png`);
    writePNG(makePNG(8, 8, [255, 255, 255, 255]), prodDir, `${safeFileName("/blog/post-b/")}.png`);

    // Missing prod image (simulates a NEW page) → "new"
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/blog/post-c/")}.png`);

    const out = path.join(tmp, "diffs.json");
    const summary = computeAll({
      changesPath: writeJSON(tmp, "changes.json", changes),
      prDir,
      prodDir,
      outPath: out,
    });

    expect(summary.pages.find((p) => p.path === "/blog/post-a/").status).toBe("identical");
    expect(summary.pages.find((p) => p.path === "/blog/post-b/").status).toBe("different");
    expect(summary.pages.find((p) => p.path === "/blog/post-c/").status).toBe("new");

    expect(summary.totals.identical).toBe(1);
    expect(summary.totals.different).toBe(1);
    expect(summary.totals.new).toBe(1);
    expect(summary.totals.visuallyDifferent).toBe(2); // different + new
    expect(summary.totals.potentiallyAffected).toBe(2); // changes.changed.length

    // Persisted to disk in the same shape
    const onDisk = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(onDisk).toEqual(summary);
  });

  test("computeAll: missing PROD baseline → no-baseline, NOT counted as a regression", async () => {
    // A changed page whose PRODUCTION screenshot is absent (new to prod, or
    // a transient prod-capture gap — the class that left #1858 stuck). We
    // can't diff it, so it must auto-pass, never forcing the manual gate.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regdiff-nb-"));
    const prDir = path.join(tmp, "pr");
    const prodDir = path.join(tmp, "prod");

    const changes = { changed: ["/blog/post-a/", "/blog/post-b/"], new: [], unchanged: [] };

    // post-a: identical on both sides.
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/blog/post-a/")}.png`);
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prodDir, `${safeFileName("/blog/post-a/")}.png`);
    // post-b: PR rendered it, but the PROD baseline is MISSING.
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/blog/post-b/")}.png`);

    const summary = computeAll({
      changesPath: writeJSON(tmp, "changes.json", changes),
      prDir,
      prodDir,
      outPath: path.join(tmp, "diffs.json"),
    });

    expect(summary.pages.find((p) => p.path === "/blog/post-b/").status).toBe("no-baseline");
    expect(summary.totals.identical).toBe(1);
    expect(summary.totals.different).toBe(0);
    expect(summary.totals.visuallyDifferent).toBe(0); // auto-pass: no manual gate
  });

  test("computeAll: visible-text change escalates a pixel-identical page to different", async () => {
    // The sub-threshold nav-link case: pixels within tolerance, but the
    // page's visible text changed — human-meaningful, must hit the gate.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regdiff-txt-"));
    const prDir = path.join(tmp, "pr");
    const prodDir = path.join(tmp, "prod");

    const changes = { changed: ["/", "/pages/about/"], new: [], unchanged: [] };

    for (const p of changes.changed) {
      writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName(p)}.png`);
      writePNG(makePNG(8, 8, [0, 0, 0, 255]), prodDir, `${safeFileName(p)}.png`);
    }
    // "/": text changed (a nav link appeared). Whitespace differences
    // alone must NOT count — about page differs only in whitespace.
    fs.writeFileSync(path.join(prodDir, `${safeFileName("/")}.txt`), "Home Blog About");
    fs.writeFileSync(path.join(prDir, `${safeFileName("/")}.txt`), "Home Blog Tools About");
    fs.writeFileSync(path.join(prodDir, `${safeFileName("/pages/about/")}.txt`), "About  me\n");
    fs.writeFileSync(path.join(prDir, `${safeFileName("/pages/about/")}.txt`), "About me");

    const summary = computeAll({
      changesPath: writeJSON(tmp, "changes.json", changes),
      prDir,
      prodDir,
      outPath: path.join(tmp, "diffs.json"),
    });

    const home = summary.pages.find((p) => p.path === "/");
    expect(home.status).toBe("different");
    expect(home.textChanged).toBe(true);
    expect(home.textDiff.pr).toContain("Tools");
    const about = summary.pages.find((p) => p.path === "/pages/about/");
    expect(about.status).toBe("identical");
    expect(about.textChanged).toBeUndefined();
    expect(summary.totals.textChanged).toBe(1);
    expect(summary.totals.visuallyDifferent).toBe(1); // escalation feeds the gate
  });

  test("computeAll: missing text dump on either side skips the text check", async () => {
    // Placeholder prod sides and capture gaps write no .txt — tolerated,
    // same rationale as no-baseline.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regdiff-notxt-"));
    const prDir = path.join(tmp, "pr");
    const prodDir = path.join(tmp, "prod");

    const changes = { changed: ["/"], new: [], unchanged: [] };
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/")}.png`);
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prodDir, `${safeFileName("/")}.png`);
    fs.writeFileSync(path.join(prDir, `${safeFileName("/")}.txt`), "Home Blog Tools");

    const summary = computeAll({
      changesPath: writeJSON(tmp, "changes.json", changes),
      prDir,
      prodDir,
      outPath: path.join(tmp, "diffs.json"),
    });

    expect(summary.pages.find((p) => p.path === "/").status).toBe("identical");
    expect(summary.totals.textChanged).toBe(0);
    expect(summary.totals.visuallyDifferent).toBe(0);
  });

  test("computeAll: prod-missing.json (HTTP 404 at capture) scores the page as new", async () => {
    // Capture-time new-page detection: prod CONFIRMED the page absent, so
    // it must count toward the review gate even though the changed-file
    // mapper never classified it — unlike a missing prod PNG (transient
    // capture gap), which stays tolerated as no-baseline.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regdiff-pm-"));
    const prDir = path.join(tmp, "pr");
    const prodDir = path.join(tmp, "prod");

    const changes = { changed: ["/tools/widget/"], new: [], unchanged: [] };
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prDir, `${safeFileName("/tools/widget/")}.png`);
    writePNG(makePNG(8, 8, [10, 10, 10, 255]), prodDir, `${safeFileName("/tools/widget/")}.png`);
    fs.writeFileSync(path.join(tmp, "prod-missing.json"), JSON.stringify(["/tools/widget/"]));

    const summary = computeAll({
      changesPath: writeJSON(tmp, "changes.json", changes),
      prDir,
      prodDir,
      outPath: path.join(tmp, "diffs.json"),
    });

    expect(summary.pages.find((p) => p.path === "/tools/widget/").status).toBe("new");
    expect(summary.totals.new).toBe(1);
    expect(summary.totals.visuallyDifferent).toBe(1);
  });

  test("computeAll: missing PR screenshot while prod exists → different (flag for review)", async () => {
    // The inverse: prod HAS the page but the PR failed to render it — a real
    // signal the PR may have broken the page, so it should be reviewed.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regdiff-pr-"));
    const prDir = path.join(tmp, "pr");
    const prodDir = path.join(tmp, "prod");

    const changes = { changed: ["/blog/post-a/"], new: [], unchanged: [] };
    writePNG(makePNG(8, 8, [0, 0, 0, 255]), prodDir, `${safeFileName("/blog/post-a/")}.png`);

    const summary = computeAll({
      changesPath: writeJSON(tmp, "changes.json", changes),
      prDir,
      prodDir,
      outPath: path.join(tmp, "diffs.json"),
    });

    expect(summary.pages.find((p) => p.path === "/blog/post-a/").status).toBe("different");
    expect(summary.totals.different).toBe(1);
    expect(summary.totals.visuallyDifferent).toBe(1);
  });
});

function writeJSON(dir, name, obj) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}
