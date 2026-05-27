// @lane: local — pure-Node unit tests for the per-test video assembler
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildFrameBannerLines,
  bucketFor,
  bucketForEntry,
  compareEntries,
  formatEastern,
  frameStepLabel,
  hostFromUrl,
  sanitizeBannerText,
  BANNER_MAX_CHARS,
  BUCKETS,
} = require("./generate-test-videos");
const { safeTestId } = require("./base");

// Pure-function tests for the per-test video assembly script. No
// browser, no ffmpeg / ImageMagick — just verify the helpers behave
// as documented.

test.describe("generate-test-videos helpers", () => {
  test("safeTestId stays filesystem-safe and bounded", () => {
    const fakeInfo = {
      file: "/abs/path/to/cms-publish-flow.spec.js",
      title: "publishes a draft / saves it (then approves)",
      project: { name: "chromium-desktop" },
      repeatEachIndex: 2,
    };
    const id = safeTestId(fakeInfo);
    expect(id.length).toBeLessThanOrEqual(180);
    // No path separators or shell-hostile characters.
    expect(id).not.toMatch(/[\\/:*?"<>|\s]/);
    // Uses the project, basename, title, and repeat index.
    expect(id).toContain("chromium-desktop");
    expect(id).toContain("cms-publish-flow.spec.js");
    expect(id).toContain("publishes-a-draft");
    expect(id).toContain("r2");
  });

  test("safeTestId tolerates emoji + unicode without producing forbidden bytes", () => {
    const id = safeTestId({
      file: "weird.spec.js",
      title: "passes ✓ on UTF-8 path/with*chars",
      project: { name: "firefox-desktop" },
      repeatEachIndex: 0,
    });
    expect(id).not.toMatch(/[\\/:*?"<>|]/);
  });

  test("compareEntries sorts by (file, title, project, repeat)", () => {
    const e1 = {
      meta: {
        file: "a.spec.js",
        title: "one",
        projectName: "chromium-desktop",
        repeatEachIndex: 0,
      },
    };
    const e2 = {
      meta: {
        file: "a.spec.js",
        title: "one",
        projectName: "firefox-desktop",
        repeatEachIndex: 0,
      },
    };
    const e3 = {
      meta: {
        file: "b.spec.js",
        title: "first",
        projectName: "chromium-desktop",
        repeatEachIndex: 0,
      },
    };
    const e4 = {
      meta: {
        file: "a.spec.js",
        title: "one",
        projectName: "chromium-desktop",
        repeatEachIndex: 1,
      },
    };
    const sorted = [e3, e2, e4, e1].sort(compareEntries);
    expect(sorted.map((s) => s.meta.projectName + "#" + s.meta.repeatEachIndex)).toEqual([
      "chromium-desktop#0",
      "chromium-desktop#1",
      "firefox-desktop#0",
      "chromium-desktop#0",
    ]);
  });

  test("formatEastern renders YYYY-MM-DD HH:MM:SS with EDT in summer", () => {
    // 2026-05-05T18:30:00Z → 14:30:00 in America/New_York (EDT, UTC-4).
    const out = formatEastern(new Date("2026-05-05T18:30:00Z"));
    expect(out).toMatch(/^2026-05-05 14:30:00 EDT$/);
  });

  test("formatEastern renders EST in winter", () => {
    // 2026-01-15T18:00:00Z → 13:00:00 in America/New_York (EST, UTC-5).
    const out = formatEastern(new Date("2026-01-15T18:00:00Z"));
    expect(out).toMatch(/^2026-01-15 13:00:00 EST$/);
  });

  test("formatEastern handles invalid input gracefully", () => {
    expect(formatEastern(null)).toBe("unknown-time");
    expect(formatEastern(undefined)).toBe("unknown-time");
    expect(formatEastern(new Date("not-a-date"))).toBe("unknown-time");
  });

  test("frameStepLabel prefers stepTitle when present", () => {
    expect(
      frameStepLabel({
        stepTitle: "Reset canary baseline",
        url: "http://localhost:4000/admin/index-local.html",
      }),
    ).toBe("Reset canary baseline");
  });

  test("frameStepLabel falls back to host+pathname when no stepTitle", () => {
    // No `test.step()` was active for this frame, so the banner falls
    // back to <host><pathname> captured by the framenavigated event.
    // For localhost / 127.0.0.1 the port (which changes per run) is
    // stripped; for other hosts the host is rendered as-is so a frame
    // on `https://adamdaniel.ai/admin/` doesn't render as just
    // `/admin/`.
    expect(
      frameStepLabel({
        url: "http://localhost:4000/admin/index-local.html#/collections/posts",
      }),
    ).toBe("localhost/admin/index-local.html");
    expect(
      frameStepLabel({
        url: "https://example.com/page?q=1",
      }),
    ).toBe("example.com/page?q=1");
  });

  test("frameStepLabel: prod URL fallback includes hostname (no leading bare /)", () => {
    expect(
      frameStepLabel({
        url: "https://adamdaniel.ai/admin/",
      }),
    ).toBe("adamdaniel.ai/admin/");
    expect(
      frameStepLabel({
        url: "https://preview-pr137.adamdaniel.ai/blog/",
      }),
    ).toBe("preview-pr137.adamdaniel.ai/blog/");
  });

  test("frameStepLabel: localhost+port strips the port", () => {
    expect(
      frameStepLabel({
        url: "http://localhost:4000/admin/",
      }),
    ).toBe("localhost/admin/");
    expect(
      frameStepLabel({
        url: "http://localhost:9999/",
      }),
    ).toBe("localhost/");
    expect(
      frameStepLabel({
        url: "http://127.0.0.1:8080/api/x",
      }),
    ).toBe("127.0.0.1/api/x");
  });

  test("frameStepLabel: stepTitle is never prefixed with hostname", () => {
    // Even when both stepTitle and a prod URL are present, stepTitle
    // wins verbatim — the step author chose the title.
    expect(
      frameStepLabel({
        stepTitle: "Reset canary baseline",
        url: "https://adamdaniel.ai/admin/",
      }),
    ).toBe("Reset canary baseline");
    expect(
      frameStepLabel({
        stepTitle: "Click Save",
        url: "http://localhost:4000/admin/",
      }),
    ).toBe("Click Save");
  });

  test("frameStepLabel: about:blank is rendered verbatim", () => {
    expect(frameStepLabel({ url: "about:blank" })).toBe("about:blank");
  });

  test("frameStepLabel: data: / blob: URLs are truncated with ellipsis", () => {
    const longData = "data:image/png;base64,iVBORw0KGgoAAAANSU" + "x".repeat(500);
    const out = frameStepLabel({ url: longData });
    expect(out.length).toBeLessThan(longData.length);
    expect(out.endsWith("…")).toBe(true);
    // First chars must be preserved literally so the scheme is visible.
    expect(out.startsWith("data:image/png")).toBe(true);

    const longBlob = "blob:" + "x".repeat(500);
    const blobOut = frameStepLabel({ url: longBlob });
    expect(blobOut.endsWith("…")).toBe(true);
    expect(blobOut.startsWith("blob:")).toBe(true);

    // Short data: URLs (under the truncation limit) pass through whole.
    const shortData = "data:,hi";
    expect(frameStepLabel({ url: shortData })).toBe(shortData);
  });

  test("frameStepLabel handles missing stepTitle and url", () => {
    expect(frameStepLabel(null)).toBe("(no navigation)");
    expect(frameStepLabel({})).toBe("(no navigation)");
    expect(frameStepLabel({ stepTitle: "" })).toBe("(no navigation)");
  });

  test("buildFrameBannerLines line 1 includes PR + Test X of Y + identity", () => {
    const lines = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 2,
      testCount: 5,
      file: "blog-post.spec.js",
      title: "displays the post title exactly once",
      stepIndex: 1,
      stepCount: 1,
      stepLabel: "/blog/replacement-test-post-1/",
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(lines[0]).toBe(
      "PR #143 · Test 2 of 5 · blog-post.spec.js::displays the post title exactly once",
    );
    // Line ordering: PR comes first, then index, then identity.
    const i1 = lines[0].indexOf("PR #143");
    const i2 = lines[0].indexOf("Test 2 of 5");
    const i3 = lines[0].indexOf("blog-post.spec.js");
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("buildFrameBannerLines line 2 includes Step x of y, label, status (in that order)", () => {
    const lines = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 1,
      testCount: 3,
      file: "f.spec.js",
      title: "t",
      stepIndex: 4,
      stepCount: 7,
      stepLabel: "Click the login button",
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(lines[1]).toBe("Step 4 of 7: Click the login button · passed");
    const i1 = lines[1].indexOf("Step 4 of 7");
    const i2 = lines[1].indexOf("Click the login button");
    const i3 = lines[1].indexOf("passed");
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("buildFrameBannerLines line 2 falls back to host+path when no step name", () => {
    // Use frameStepLabel directly to derive the label from a frame
    // record that has no stepTitle — the most common scenario for
    // tests that don't wrap their navs in test.step(). The host is
    // included so the env (local/prod) is unambiguous in the banner.
    const stepLabel = frameStepLabel({
      url: "http://localhost:4000/blog/replacement-test-post-1/",
    });
    const lines = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel,
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(lines[1]).toBe("Step 1 of 1: localhost/blog/replacement-test-post-1/ · passed");
  });

  test("buildFrameBannerLines line 2: prod URL fallback renders <host><path>", () => {
    const stepLabel = frameStepLabel({
      url: "https://adamdaniel.ai/admin/",
    });
    const lines = buildFrameBannerLines({
      prNumber: 200,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel,
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(lines[1]).toBe("Step 1 of 1: adamdaniel.ai/admin/ · passed");
  });

  test("buildFrameBannerLines line 2: localhost+port strips the port", () => {
    const stepLabel = frameStepLabel({
      url: "http://localhost:4000/admin/",
    });
    const lines = buildFrameBannerLines({
      prNumber: 200,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel,
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(lines[1]).toBe("Step 1 of 1: localhost/admin/ · passed");
  });

  test("buildFrameBannerLines line 2: stepTitle present passes through unchanged", () => {
    // Even when frameStepLabel could synthesize a host-prefixed path
    // from the URL, an explicit stepTitle wins verbatim.
    const stepLabel = frameStepLabel({
      stepTitle: "Open the Posts collection",
      url: "https://adamdaniel.ai/admin/#/collections/posts",
    });
    const lines = buildFrameBannerLines({
      prNumber: 200,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel,
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(lines[1]).toBe("Step 1 of 1: Open the Posts collection · passed");
    expect(lines[1]).not.toContain("adamdaniel.ai");
  });

  test("buildFrameBannerLines line 3 reads `project: ... · <date+time TZ>` in America/New_York", () => {
    const summer = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel: "/x",
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    expect(summer[2]).toBe("project: chromium-desktop · 2026-05-05 14:30:00 EDT");
    const winter = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel: "/x",
      status: "passed",
      projectName: "firefox-desktop",
      endTime: new Date("2026-01-15T18:00:00Z"),
    });
    expect(winter[2]).toBe("project: firefox-desktop · 2026-01-15 13:00:00 EST");
    // TZ abbrev must be present.
    expect(summer[2]).toMatch(/\bEDT\b/);
    expect(winter[2]).toMatch(/\bEST\b/);
  });

  test("buildFrameBannerLines uses each frame's own end-time, not a run-wide stamp", () => {
    // Two tests with different endTimes — the banner on each must
    // reflect that test's own completion stamp.
    const a = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 1,
      testCount: 2,
      file: "a.spec.js",
      title: "first",
      stepIndex: 1,
      stepCount: 1,
      stepLabel: "/x",
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    const b = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 2,
      testCount: 2,
      file: "b.spec.js",
      title: "second",
      stepIndex: 1,
      stepCount: 1,
      stepLabel: "/y",
      status: "passed",
      projectName: "chromium-desktop",
      endTime: new Date("2026-05-05T19:45:42Z"),
    });
    expect(a[2]).toContain("14:30:00 EDT");
    expect(b[2]).toContain("15:45:42 EDT");
    // Confirm independence: these two reach two distinct stamps.
    expect(a[2]).not.toBe(b[2]);
  });

  test("buildFrameBannerLines: rendering 5 fake test directories assigns X = 1..5 and Y = 5", () => {
    // Simulate the assembly's outer loop: testIndex iterates 1..N,
    // testCount = N. Verify each fake test gets the right banner.
    const fakeMetas = [
      { file: "a.spec.js", title: "x", projectName: "chromium-desktop" },
      { file: "b.spec.js", title: "y", projectName: "chromium-desktop" },
      { file: "c.spec.js", title: "z", projectName: "chromium-desktop" },
      { file: "d.spec.js", title: "p", projectName: "firefox-desktop" },
      { file: "e.spec.js", title: "q", projectName: "webkit-desktop" },
    ];
    const lines = fakeMetas.map((m, i) =>
      buildFrameBannerLines({
        prNumber: 99,
        testIndex: i + 1,
        testCount: fakeMetas.length,
        file: m.file,
        title: m.title,
        stepIndex: 1,
        stepCount: 3,
        stepLabel: "/foo",
        status: "passed",
        projectName: m.projectName,
        endTime: new Date("2026-05-05T18:30:00Z"),
      }),
    );
    for (let i = 0; i < 5; i++) {
      expect(lines[i][0]).toContain(`Test ${i + 1} of 5`);
      expect(lines[i][0]).toContain(fakeMetas[i].file);
      expect(lines[i][2]).toContain(`project: ${fakeMetas[i].projectName}`);
    }
  });

  test("sanitizeBannerText strips control chars and squeezes whitespace", () => {
    expect(sanitizeBannerText("abc def")).toBe("abc def");
    expect(sanitizeBannerText("a   b\nc")).toBe("a b c");
    expect(sanitizeBannerText("  trim me  ")).toBe("trim me");
  });

  test("sanitizeBannerText truncates oversized strings", () => {
    const huge = "x".repeat(BANNER_MAX_CHARS + 50);
    const out = sanitizeBannerText(huge);
    expect(out.length).toBeLessThanOrEqual(BANNER_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  test("buildFrameBannerLines truncates very long step names without overflowing", () => {
    const longStep = "a".repeat(500);
    const lines = buildFrameBannerLines({
      prNumber: 143,
      testIndex: 1,
      testCount: 1,
      file: "f.spec.js",
      title: "t",
      stepIndex: 1,
      stepCount: 1,
      stepLabel: longStep,
      status: "passed",
      projectName: "p",
      endTime: new Date("2026-05-05T18:30:00Z"),
    });
    // line 2 must not exceed the per-line cap.
    expect(lines[1].length).toBeLessThanOrEqual(BANNER_MAX_CHARS);
    expect(lines[1]).toMatch(/^Step 1 of 1: /);
  });
});

// ── Bucket assignment ────────────────────────────────────────────────
//
// The combined-aggregation stage subdivides the run by target
// environment so reviewers can scrub one bucket without scrolling
// through the rest. Buckets are computed from the FIRST captured
// frame's hostname per test (one rule beats per-frame fragmentation).

test.describe("bucketFor: target env classification", () => {
  test("prod: apex adamdaniel.ai", () => {
    expect(bucketFor("adamdaniel.ai")).toBe("prod");
  });

  test("preview: preview-pr<N>.adamdaniel.ai", () => {
    expect(bucketFor("preview-pr137.adamdaniel.ai")).toBe("preview");
    expect(bucketFor("preview-pr1.adamdaniel.ai")).toBe("preview");
    expect(bucketFor("preview-pr9999.adamdaniel.ai")).toBe("preview");
  });

  test("local: localhost / 127.0.0.1 (port-agnostic)", () => {
    expect(bucketFor("localhost")).toBe("local");
    expect(bucketFor("127.0.0.1")).toBe("local");
  });

  test("other: catch-all for blanks, unknown hosts, and oddballs", () => {
    expect(bucketFor("")).toBe("other");
    expect(bucketFor("about:blank")).toBe("other");
    expect(bucketFor(undefined)).toBe("other");
    expect(bucketFor(null)).toBe("other");
    expect(bucketFor("github.com")).toBe("other");
    expect(bucketFor("example.com")).toBe("other");
  });

  test("preview rule does NOT match nearby strings", () => {
    // Subdomains that aren't preview-pr<digits> stay in `other`.
    expect(bucketFor("staging.adamdaniel.ai")).toBe("other");
    expect(bucketFor("preview.adamdaniel.ai")).toBe("other");
    expect(bucketFor("preview-prabc.adamdaniel.ai")).toBe("other");
    // Hostname must be exact: no `evil.adamdaniel.ai.attacker.com`.
    expect(bucketFor("preview-pr1.adamdaniel.ai.attacker.com")).toBe("other");
    expect(bucketFor("preview-pr1.example.com")).toBe("other");
  });

  test("prod rule does NOT match nearby strings", () => {
    // The apex `adamdaniel.ai` is prod; subdomains land in `preview`
    // (if they match preview-pr<N>) or `other`.
    expect(bucketFor("www.adamdaniel.ai")).toBe("other");
    expect(bucketFor("api.adamdaniel.ai")).toBe("other");
    expect(bucketFor("adamdaniel.ai.attacker.com")).toBe("other");
  });

  test("BUCKETS list documents the four buckets in canonical order", () => {
    expect(BUCKETS).toEqual(["local", "preview", "prod", "other"]);
  });
});

test.describe("hostFromUrl: hostname extraction", () => {
  test("strips port from localhost / 127.0.0.1", () => {
    expect(hostFromUrl("http://localhost:4000/admin/")).toBe("localhost");
    expect(hostFromUrl("http://127.0.0.1:8080/api")).toBe("127.0.0.1");
  });

  test("returns the apex / subdomain for a normal URL", () => {
    expect(hostFromUrl("https://adamdaniel.ai/admin/")).toBe("adamdaniel.ai");
    expect(hostFromUrl("https://preview-pr137.adamdaniel.ai/")).toBe("preview-pr137.adamdaniel.ai");
    expect(hostFromUrl("https://example.com/page?q=1")).toBe("example.com");
  });

  test("returns empty string for blanks, about:blank, data:, blob:", () => {
    expect(hostFromUrl("")).toBe("");
    expect(hostFromUrl(null)).toBe("");
    expect(hostFromUrl(undefined)).toBe("");
    expect(hostFromUrl("about:blank")).toBe("");
    expect(hostFromUrl("data:image/png;base64,iVB")).toBe("");
    expect(hostFromUrl("blob:http://localhost:4000/abc-123")).toBe("");
  });

  test("returns empty string for malformed URLs", () => {
    expect(hostFromUrl("not a url at all")).toBe("");
  });
});

test.describe("bucketForEntry: per-test bucket from FIRST frame's host", () => {
  test("uses the FIRST captured frame's host", () => {
    const entry = {
      meta: {
        frames: [
          { url: "http://localhost:4000/admin/" },
          { url: "https://adamdaniel.ai/oauth-callback/" }, // ignored
        ],
      },
    };
    expect(bucketForEntry(entry)).toBe("local");
  });

  test("entry with no frames falls through to `other`", () => {
    expect(bucketForEntry({ meta: { frames: [] } })).toBe("other");
    expect(bucketForEntry({ meta: {} })).toBe("other");
    expect(bucketForEntry({})).toBe("other");
  });

  test("preview-PR test buckets to preview regardless of subsequent navs", () => {
    const entry = {
      meta: {
        frames: [
          { url: "https://preview-pr137.adamdaniel.ai/" },
          { url: "https://github.com/login" }, // ignored
        ],
      },
    };
    expect(bucketForEntry(entry)).toBe("preview");
  });
});

// ── Bucketed combined-video assembly ─────────────────────────────────
//
// Verifies the combined-aggregation stage emits one mp4 per non-empty
// bucket and writes a manifest that lists each test under its bucket.
// Mocks ffmpeg via FFMPEG=/bin/true so no real codec activity happens
// — we only assert on the wiring (output paths, manifest contents,
// per-bucket assignment).

test.describe("buildBucketedCombinedVideos: per-bucket assembly", () => {
  test("emits one mp4 per non-empty bucket; manifest lists tests under their bucket", async () => {
    // Spawn a child Node process with FFMPEG=/bin/true (so ffmpeg
    // invocations succeed without producing real mp4s) and a unique
    // VIDEOS_ROOT in a tmp dir.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vidv2-bucket-"));
    const videosRoot = path.join(tmpRoot, "per-test-videos");
    fs.mkdirSync(videosRoot, { recursive: true });

    // Stage six fake per-test mp4s on disk so the concat list can
    // resolve them, even though /bin/true won't read them.
    const mkPerTest = (name) => {
      const p = path.join(videosRoot, `${name}.mp4`);
      fs.writeFileSync(p, "");
      return p;
    };

    // Six fake "tests" across three buckets (local x3, prod x2,
    // preview x1, plus zero in `other` to verify it gets skipped).
    const records = [
      {
        entry: {
          frames: ["0000.png"],
          meta: {
            file: "a.spec.js",
            title: "ta",
            projectName: "chromium-desktop",
            repeatEachIndex: 0,
            status: "passed",
            endTime: "2026-05-05T18:30:00Z",
            frames: [{ url: "http://localhost:4000/" }],
          },
        },
        perTestPath: mkPerTest("a-local-1"),
        bucket: "local",
      },
      {
        entry: {
          frames: ["0000.png"],
          meta: {
            file: "b.spec.js",
            title: "tb",
            projectName: "chromium-desktop",
            repeatEachIndex: 0,
            status: "passed",
            endTime: "2026-05-05T18:31:00Z",
            frames: [{ url: "http://127.0.0.1:8080/" }],
          },
        },
        perTestPath: mkPerTest("b-local-2"),
        bucket: "local",
      },
      {
        entry: {
          frames: ["0000.png"],
          meta: {
            file: "c.spec.js",
            title: "tc",
            projectName: "firefox-desktop",
            repeatEachIndex: 0,
            status: "passed",
            endTime: "2026-05-05T18:32:00Z",
            frames: [{ url: "http://localhost:4000/admin/" }],
          },
        },
        perTestPath: mkPerTest("c-local-3"),
        bucket: "local",
      },
      {
        entry: {
          frames: ["0000.png"],
          meta: {
            file: "d.spec.js",
            title: "td",
            projectName: "chromium-desktop",
            repeatEachIndex: 0,
            status: "passed",
            endTime: "2026-05-05T18:33:00Z",
            frames: [{ url: "https://adamdaniel.ai/" }],
          },
        },
        perTestPath: mkPerTest("d-prod-1"),
        bucket: "prod",
      },
      {
        entry: {
          frames: ["0000.png"],
          meta: {
            file: "e.spec.js",
            title: "te",
            projectName: "chromium-desktop",
            repeatEachIndex: 0,
            status: "passed",
            endTime: "2026-05-05T18:34:00Z",
            frames: [{ url: "https://adamdaniel.ai/admin/" }],
          },
        },
        perTestPath: mkPerTest("e-prod-2"),
        bucket: "prod",
      },
      {
        entry: {
          frames: ["0000.png"],
          meta: {
            file: "f.spec.js",
            title: "tf",
            projectName: "chromium-desktop",
            repeatEachIndex: 0,
            status: "passed",
            endTime: "2026-05-05T18:35:00Z",
            frames: [{ url: "https://preview-pr200.adamdaniel.ai/" }],
          },
        },
        perTestPath: mkPerTest("f-preview-1"),
        bucket: "preview",
      },
    ];

    // Re-load the module under a fresh require cache so VIDEOS_ROOT /
    // FFMPEG env vars take effect for this test.
    const modPath = require.resolve("./generate-test-videos");
    delete require.cache[modPath];
    const prevVideosRoot = process.env.VIDEOS_ROOT;
    const prevFfmpeg = process.env.FFMPEG;
    process.env.VIDEOS_ROOT = videosRoot;
    process.env.FFMPEG = "/bin/true";
    let mod;
    try {
      mod = require(modPath);
      const emitted = mod.buildBucketedCombinedVideos(records);
      // Three non-empty buckets emit, `other` is skipped.
      expect(Object.keys(emitted).sort()).toEqual(["local", "preview", "prod"]);
      expect(emitted.local).toBe(path.join(videosRoot, "_combined-local.mp4"));
      expect(emitted.preview).toBe(path.join(videosRoot, "_combined-preview.mp4"));
      expect(emitted.prod).toBe(path.join(videosRoot, "_combined-prod.mp4"));
      // No `other` mp4 (zero records there → silently omitted).
      expect(fs.existsSync(path.join(videosRoot, "_combined-other.mp4"))).toBe(false);
      // No master `_combined.mp4` is produced.
      expect(fs.existsSync(path.join(videosRoot, "_combined.mp4"))).toBe(false);

      // Manifest lists each test under its bucket header.
      const manifestPath = mod.writeManifest(records, "143", emitted);
      const manifest = fs.readFileSync(manifestPath, "utf8");
      expect(manifest).toContain("Bucket local → _combined-local.mp4 (3 tests)");
      expect(manifest).toContain("Bucket preview → _combined-preview.mp4 (1 test)");
      expect(manifest).toContain("Bucket prod → _combined-prod.mp4 (2 tests)");
      // `other` is empty — manifest should explicitly note that.
      expect(manifest).toContain("Bucket other → (empty — no combined video emitted)");
      // Each test row appears under its bucket section.
      expect(manifest).toContain("a-local-1.mp4");
      expect(manifest).toContain("b-local-2.mp4");
      expect(manifest).toContain("c-local-3.mp4");
      expect(manifest).toContain("d-prod-1.mp4");
      expect(manifest).toContain("e-prod-2.mp4");
      expect(manifest).toContain("f-preview-1.mp4");
      // PR + bucketing metadata in the header.
      expect(manifest).toContain("PR:        #143");
      expect(manifest).toContain("Tests:     6");
      expect(manifest).toMatch(/Buckets:\s+local \| preview \| prod \| other/);
    } finally {
      // Restore env so other tests see the originals.
      if (prevVideosRoot === undefined) delete process.env.VIDEOS_ROOT;
      else process.env.VIDEOS_ROOT = prevVideosRoot;
      if (prevFfmpeg === undefined) delete process.env.FFMPEG;
      else process.env.FFMPEG = prevFfmpeg;
      delete require.cache[modPath];
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
