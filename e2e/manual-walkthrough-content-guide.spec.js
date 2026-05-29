// @lane: local — walkthrough capture against the local Jekyll site; @parity-eligible via TARGET=
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, TARGET } = require("./base");
const { captureStep } = require("./manual-capture");

// Plan unit C2: every documented affordance in `docs/CONTENT_GUIDE.md` should
// have a runtime probe. The guide is the editor-facing source of truth — if
// it claims that opening `/preview/?collection=posts` shows the live preview
// shell, or that `/admin/`'s media library has an upload button, those
// claims must keep being true. Static-text contracts (the kind W1–W6 added)
// don't catch the case where the markdown still says "click X" but the
// rendered DOM no longer renders X.
//
// What this spec does:
//   1. Parse `docs/CONTENT_GUIDE.md` for `## ` headings + their line numbers.
//   2. Generate one Playwright test per heading. Each test dispatches to a
//      probe function based on the section title.
//   3. Probes that exercise a real surface (Two ways to preview, Media
//      library) navigate and assert the relevant DOM exists.
//   4. Probes for sections that are pure narrative (Sign in's GitHub OAuth,
//      Save → review → publish's PR flow, Troubleshooting tables, behind-the-
//      scenes commentary) emit `test.fixme` placeholders carrying the section
//      line number — so a later pass can flesh them out without losing track
//      of what's still uncovered.
//   5. Failure messages always cite the section title + line number, so a
//      regression points back at the markdown line that promised the missing
//      affordance.
//
// Tagged @parity in the test titles so the future cross-target matrix
// (TARGET=preview / TARGET=prod, see plan Phase 2 / G3) picks the read-only
// probes up automatically.

const REPO_ROOT = path.join(__dirname, "..");
const GUIDE_PATH = path.join(REPO_ROOT, "docs", "CONTENT_GUIDE.md");

// Parse `^## ` headings out of the guide. Returns an array of
// { title, line, slug } records — one per section.
function parseSections(markdown) {
  const sections = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const title = m[1].trim();
    sections.push({
      title,
      line: i + 1, // human-friendly 1-indexed line numbers
      slug: title
        .toLowerCase()
        .replace(/^\d+\.\s+/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    });
  }
  return sections;
}

function citation(section) {
  return `${path.relative(REPO_ROOT, GUIDE_PATH)}:${section.line} (## ${section.title})`;
}

// ── Probes ───────────────────────────────────────────────────────────
//
// Each probe is `async (page, section) => void`. They throw — the test
// wrapper translates that into a Playwright failure with the section
// citation prepended. Probes that don't have a runtime expression yet
// throw `FixmeError` so the wrapper marks the test fixme rather than
// failing it.

class FixmeError extends Error {
  constructor(message) {
    super(message);
    this.name = "FixmeError";
  }
}

// "Two ways to preview" — the guide tells editors to open
// `/preview/?collection=posts` (and `?collection=projects` /
// `?collection=pages`) in a second tab, and promises that the page
// renders with the real layouts. Probe: every documented preview URL
// returns 200, the preview-root marker is present, and the documented
// layout shell is mounted.
async function probePreview(page, section) {
  const variants = [
    {
      query: "?collection=posts",
      layout: "posts",
      // The post layout's <h1> sits inside .post-header in _layouts/post.html.
      header: ".post-header h1",
    },
    {
      query: "?collection=projects",
      layout: "projects",
      header: '[data-preview-layout="projects"] .post-header h1',
    },
    {
      query: "?collection=pages",
      layout: "pages",
      header: ".page-header h1",
    },
  ];
  for (const v of variants) {
    const url = `/preview/${v.query}`;
    const response = await page.goto(url);
    if (!response || response.status() !== 200) {
      throw new Error(
        `${citation(section)}: GET ${url} returned ${response ? response.status() : "no response"}, but the guide says editors snap this URL "next to the editor".`,
      );
    }
    // Documented preview-root marker — _layouts/preview.html sets it.
    const root = page.locator("[data-preview-root]");
    if (!(await root.count())) {
      throw new Error(
        `${citation(section)}: ${url} loaded but the [data-preview-root] marker is missing. The guide promises the real Jekyll layouts render here.`,
      );
    }
    // Active variant should be on the page (other variants are stripped
    // by the preview shell so the active layout is unambiguous).
    const activeLayout = page.locator(`[data-preview-layout="${v.layout}"]`);
    if (!(await activeLayout.count())) {
      throw new Error(
        `${citation(section)}: ${url} did not mount [data-preview-layout="${v.layout}"]. Editors who follow the guide will see an empty preview.`,
      );
    }
    // The layout's header element exists (proves the layout shell is real,
    // not a stub).
    const header = page.locator(v.header).first();
    await expect(
      header,
      `${citation(section)}: ${url} is missing ${v.header} — the layout shell didn't mount the way the guide promises.`,
    ).toBeAttached({ timeout: 10_000 });
  }

  await captureStep(page, {
    section: "Real-layout preview",
    step: "C2.1",
    title: "Open /preview/?collection=posts in a second tab",
    body: "The Editor's Guide tells you to open `https://adamdaniel.ai/preview/?collection=posts` and snap it next to the editor. Each Save in the admin updates this tab within a frame, rendered with the real `_layouts/post.html` so it matches the live site exactly. The same pattern works for `?collection=projects` and `?collection=pages`.",
  });
}

// "Media library" — the guide claims uploads land directly in
// `assets/images/uploads/`, that any image field opens
// the picker, and that you can browse / re-use prior uploads. Probe:
// load the local admin, sign in (no real OAuth, decap-server is
// permissive), open a Posts entry, click the Featured Image field's
// "Choose Image" — assert the media library opens with both a grid
// (existing uploads, even if empty) and an Upload control.
async function probeMediaLibrary(page, section) {
  await page.goto("/admin/index-local.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(
    loginBtn,
    `${citation(section)}: /admin/ never showed the Login button. The guide assumes editors have signed in before browsing the media library.`,
  ).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();

  await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
  await page.goto("/admin/index-local.html#/collections/posts/new");

  const titleField = page.getByLabel(/^Title$/);
  await expect(
    titleField,
    `${citation(section)}: Posts edit form never rendered, so we can't reach the Featured Image picker the guide describes.`,
  ).toBeVisible({ timeout: 60_000 });

  // The guide: "Click any image field → Choose Image". Decap's button
  // is labelled "Choose an Image" / "Choose Image" depending on
  // version; match both.
  const chooseImage = page.getByRole("button", { name: /choose (an )?image/i }).first();
  await expect(
    chooseImage,
    `${citation(section)}: the Featured Image widget did not render its "Choose Image" button — the documented "click any image field" entry-point is gone.`,
  ).toBeVisible({ timeout: 30_000 });
  await chooseImage.click();

  // Decap's media library mounts a hidden <input type="file" accept="image/*"> —
  // that's the documented upload affordance. Without it there is no way
  // to upload a new asset, which directly contradicts the section's
  // promise.
  const fileInput = page.locator('input[type="file"][accept*="image"]').first();
  await expect(
    fileInput,
    `${citation(section)}: media library opened but no file input was attached. The guide promises an upload affordance.`,
  ).toBeAttached({ timeout: 30_000 });

  // Library grid: Decap's MediaLibrary component renders the existing
  // uploads as a list. The element exposes role="listbox"-like
  // semantics depending on version; we use a structural selector
  // instead so the test stays version-tolerant. The library dialog has
  // a Cancel/Close button — its presence proves the dialog mounted.
  const dialogClose = page.getByRole("button", { name: /^(cancel|close)$/i });
  await expect(
    dialogClose.first(),
    `${citation(section)}: media library dialog did not mount a Cancel / Close control — the dialog isn't reachable.`,
  ).toBeVisible({ timeout: 30_000 });

  await captureStep(page, {
    section: "Media library",
    step: "C2.2",
    title: "Open the media library from a Posts edit form",
    body: "Click any image field's **Choose Image** button to open the media library. The dialog hosts a grid of every prior upload (a single flat folder, since `media_folder: assets/images/uploads` is the configured layout) plus an Upload control wired to a hidden `<input type=\"file\">`. Every upload's public URL is `/assets/images/uploads/<filename>` — byte-identical to where the file is committed, so Copy Path and the rendered image always resolve.",
  });

  // Back out of the dialog cleanly so we don't leak state into a
  // later test on the same page.
  await dialogClose.first().click();
}

// Sections the guide describes but that we haven't yet wired a runtime
// probe for. Each one is intentionally listed so the fixme surface
// stays visible — burying these inside one big "TODO" would hide the
// uncovered surface from anyone reading the test report.
function deferProbe(reason) {
  return async (_page, section) => {
    throw new FixmeError(`${citation(section)}: ${reason}`);
  };
}

// Map section slug → probe. Slugs are derived from the markdown heading
// after stripping the `N. ` numeric prefix. Anything not in this map
// drops to the default-deferred probe, which fails fixme rather than
// failing outright — uncovered sections stay loud without breaking CI.
const PROBES = {
  // Section 4: "Two ways to preview"
  "two-ways-to-preview": probePreview,

  // Section 7: "Media library"
  "media-library": probeMediaLibrary,

  // The narrative sections — the guide's coverage of these flows
  // overlaps real surfaces probed by other specs (cms-smoke,
  // cms-editorial-workflow, cms-publish-flow, etc.) but nothing
  // currently asserts that the guide's *own* claims still hold. Future
  // C2 passes can flesh these out.
  "sign-in": deferProbe(
    "Sign in flow: documents `/admin/` + GitHub OAuth round-trip. Real OAuth probe needs the production proxy; deferred until prod-target wiring lands (G3).",
  ),
  "the-four-collections": deferProbe(
    "Four collections sidebar: cms-smoke already asserts Posts/Tags/Projects/Pages links render after login; reuse that probe under captureStep here in a follow-up.",
  ),
  "write-a-blog-post": deferProbe(
    "Posts schema fields (Title, Date, Body, URL Slug, Excerpt, Tags, Featured Image, Published, Publish Date): cms-smoke covers most via label assertions; this section's runtime probe should re-cite the guide's promise per field.",
  ),
  "save-review-publish": deferProbe(
    "Editorial workflow + status vs. published table: cms-editorial-workflow asserts the PR-label translation, but no probe binds it back to this guide section. Wire one in a follow-up.",
  ),
  "other-content-types": deferProbe(
    "Tags / Projects / Pages collection schemas: cms-config covers the YAML side but nothing connects it to the guide's per-collection field list.",
  ),
  troubleshooting: deferProbe(
    "Troubleshooting table is reactive guidance — needs per-row probes for each documented symptom (login loop, missing Create button, draft-not-live, scheduled-not-live, preview not updating, etc.). Largest follow-up surface.",
  ),
  "what-s-happening-behind-the-scenes": deferProbe(
    "Pipeline narrative: each step (cms branch → PR → preview deploy → regression video → label flip → squash → production deploy) has a workflow-level assertion elsewhere; no probe currently re-asserts them as a single flow under this section.",
  ),
};

// ── Test wiring ──────────────────────────────────────────────────────

const guideExists = fs.existsSync(GUIDE_PATH);
const sections = guideExists ? parseSections(fs.readFileSync(GUIDE_PATH, "utf8")) : [];

test.describe(
  "Manual walkthrough — docs/CONTENT_GUIDE.md @parity",
  // Tagged @admin-screenshots: drives local /admin to capture
  // content-guide screenshots. Runs on chromium-desktop-3k ONLY
  // (single-browser by design — see manual-walkthrough-contributor
  // for the rationale). See playwright.config.js.
  { tag: ["@admin-screenshots"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test.beforeEach(({ page }) => {
      test.skip(
        TARGET === "prod",
        "Probes drive /admin/index-local.html (local_backend: true). prod has no local proxy, so login can't populate the sidebar.",
      );
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
      // Decap CMS uses native window.confirm() for delete / unpublish
      // confirmations; without a persistent listener, Playwright auto-
      // dismisses the dialog and Decap reads it as "user cancelled."
      // Defensive in case future probes exercise destructive actions —
      // see AGENTS.md "Test-Driven Design" section.
      page.on("dialog", (d) => d.accept());
    });

    if (!guideExists) {
      test.fixme("docs/CONTENT_GUIDE.md missing — nothing to walk through @parity", () => {
        // Intentional: the guide's absence is itself a doc bug, but we
        // don't want this spec to be the thing that breaks CI when
        // someone is mid-rename. Surfacing as fixme keeps it visible
        // without going red.
      });
      return;
    }

    // Sanity check: the guide should expose at least the two sections we
    // do have probes for. If parsing breaks (or the guide is renamed),
    // this fails first with a clear pointer instead of every section
    // skipping silently.
    test("CONTENT_GUIDE.md parses and exposes the documented section list @parity", () => {
      expect(
        sections.length,
        `${path.relative(REPO_ROOT, GUIDE_PATH)} produced 0 ## headings — the parser or the guide structure changed.`,
      ).toBeGreaterThan(0);
      const slugs = sections.map((s) => s.slug);
      for (const required of ["two-ways-to-preview", "media-library"]) {
        expect(
          slugs,
          `Expected section slug "${required}" in ${path.relative(REPO_ROOT, GUIDE_PATH)}; got ${JSON.stringify(slugs)}.`,
        ).toContain(required);
      }
    });

    for (const section of sections) {
      const probe = PROBES[section.slug];
      const baseTitle = `[L${section.line}] ${section.title} @parity`;

      if (!probe) {
        // No mapping at all — probably a new section was added to the
        // guide. Mark fixme with the line number so the next reader
        // knows where to look.
        test.fixme(`${baseTitle} (no probe wired — add one in PROBES["${section.slug}"])`, () => {});
        continue;
      }

      test(baseTitle, async ({ page }) => {
        try {
          await probe(page, section);
        } catch (err) {
          if (err instanceof FixmeError) {
            test.fixme(true, err.message);
            return;
          }
          throw err;
        }
      });
    }
  },
);
