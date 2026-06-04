// @lane: local — drives the local /admin shell for contributor walkthrough capture
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, TARGET } = require("./base");
const { guard } = require("./base-collections-guards");
const { captureStep } = require("./manual-capture");

// C1 — Manual-driven walkthrough for the contributor manual.
//
// Goal: every section in `docs/CONTRIBUTOR_MANUAL.md` (auto-generated
// by `MANUAL_CAPTURE=1` runs of the other CMS specs) should map to a
// runtime probe here. If a documented affordance disappears from the
// live admin — a label was renamed, a button moved, a collection was
// dropped — this spec fails with a message that points the maintainer
// at the exact markdown line + section header to update.
//
// The spec is intentionally thin. It does NOT re-test what the upstream
// specs already test (that's their job). It re-asserts the *single
// load-bearing affordance* documented in each section, so that the
// manual stays honest without duplicating workflow-level coverage.
//
// On a fresh checkout where the manual hasn't been regenerated yet,
// the file may be sparse — in that case the spec emits `test.fixme()`
// pointing at the regen workflow rather than failing meaninglessly.
//
// Tagged `@parity` so the future TARGET= env switch (G3) picks it up
// for cross-target runs against local / preview-pr* / prod.

const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");  // #33 base_collections guard root
const MANUAL_PATH = path.join(REPO_ROOT, "docs", "CONTRIBUTOR_MANUAL.md");
const REGEN_WORKFLOW = ".github/workflows/regenerate-manual.yml";

// Parse `## ` headings out of the manual. Returns an array of
// `{ title, line }` records; `line` is 1-based to match editor line
// numbers in error messages.
function parseManualSections(markdown) {
  const sections = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    // Skip the "## Sections" table-of-contents heading — it's not a
    // documented flow, just a TOC the manual builder emits.
    if (/^sections$/i.test(m[1])) continue;
    sections.push({ title: m[1], line: i + 1 });
  }
  return sections;
}

// Heuristic: a manual is "sparse" if it has fewer than 3 walkthrough
// sections beyond the TOC. The auto-generated manual has 8 today;
// fewer than 3 means a fresh checkout that hasn't regenerated yet.
function isManualSparse(sections) {
  return sections.length < 3;
}

// Look up a probe by section header. Match is case-insensitive and
// substring-based so minor wording drift in the manual doesn't break
// the wiring (e.g. "Logging in" vs. "Log in").
function findProbe(sectionTitle) {
  const t = sectionTitle.toLowerCase();
  for (const probe of PROBES) {
    if (probe.match.some((m) => t.includes(m))) return probe;
  }
  return null;
}

// ── Probes ──────────────────────────────────────────────────────────
//
// Each probe:
//   - `match`: lowercased substrings of section headers it covers.
//   - `name`: short label used in the test title.
//   - `run(page, ctx)`: async fn that asserts the documented affordance
//     still exists. Receives `ctx` with `{ section, line }` so the
//     probe can include them in any failure message.
//
// Mapping isn't exhaustive — sections without a probe get a
// `TODO: add probe for §<header>` comment in the rendered failure
// path so future authors can plug them in.
const PROBES = [
  {
    match: ["logging in", "log in"],
    name: "Login button visible at /admin/",
    async run(page, ctx) {
      // Section 22 of the manual: "Visit `/admin/` to open the editor.
      // Decap shows a single login button". We hit the local-backend
      // admin so we don't need real GitHub OAuth — the button is the
      // same DOM element either way (Decap renders the auth screen
      // identically; only the backend-init code differs).
      await page.goto("/admin/index-local.html");
      const loginBtn = page.getByRole("button", { name: /login/i });
      await expect(
        loginBtn,
        `Manual section §${ctx.section} (line ${ctx.line}) → Login button missing on /admin/. The manual claims "Decap shows a single login button" but no button matching /login/i is visible.`,
      ).toBeVisible({ timeout: 60_000 });
      await captureStep(page, {
        section: "Manual probe — login",
        step: `c1-${ctx.line}`,
        title: `Login button present (manual line ${ctx.line})`,
        body: "C1 runtime probe: confirms the login button affordance documented in the Logging in section of the contributor manual still exists at /admin/.",
      });
    },
  },
  {
    match: ["browsing collections", "collection grid", "collections list"],
    name: "All four collections in sidebar",
    async run(page, ctx) {
      // Manual claims: "the sidebar lists every collection defined in
      // admin/config.yml — Posts, Tags, Projects, Pages". Click login
      // on the local backend (no OAuth) and assert each link.
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      const expected = ["posts", "tags", "projects", "pages"];
      for (const name of expected) {
        const link = page.getByRole("link", {
          name: new RegExp(`^${name}$`, "i"),
        });
        await expect(
          link,
          `Manual section §${ctx.section} (line ${ctx.line}) → Sidebar collection "${name}" missing. The manual lists Posts/Tags/Projects/Pages but the live admin sidebar doesn't render a link for "${name}".`,
        ).toBeVisible({ timeout: 30_000 });
      }
      await captureStep(page, {
        section: "Manual probe — collections",
        step: `c1-${ctx.line}`,
        title: `Sidebar collections present (manual line ${ctx.line})`,
        body: "C1 runtime probe: confirms every collection listed in the Browsing collections section of the manual (Posts, Tags, Projects, Pages) is still rendered in the live admin sidebar.",
      });
    },
  },
  {
    match: ["editing a post", "entry form", "posts edit"],
    name: "Posts edit form has all 9 documented fields",
    async run(page, ctx) {
      // Manual claims: "The Posts edit form renders every field declared
      // in admin/config.yml: Title, URL Slug, Date, Excerpt, Tags,
      // Featured Image, Published, Publish Date, and the Body markdown
      // editor." That's 9 documented affordances — same list locked in
      // by `e2e/cms-field-targeting.spec.js` and the canary test in
      // `e2e/cms-smoke.spec.js`.
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
      await page.getByRole("link", { name: /^posts$/i }).click();
      const firstEntry = page.locator('a[href*="#/collections/posts/entries/"]').first();
      await firstEntry.waitFor({ timeout: 30_000 });
      await firstEntry.click();
      await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });

      const documentedLabels = [
        "Title",
        "URL Slug",
        "Date",
        "Excerpt",
        "Tags",
        "Featured Image",
        "Published",
        "Publish Date",
        "Body",
      ];
      for (const label of documentedLabels) {
        const labelLocator = page
          .locator("label, h3, h4, legend")
          .filter({ hasText: new RegExp(`^\\s*${label}(\\s|\\(|$)`, "i") })
          .first();
        await expect(
          labelLocator,
          `Manual section §${ctx.section} (line ${ctx.line}) → documented field "${label}" not rendered in the Posts edit form. The manual lists 9 fields (Title, URL Slug, Date, Excerpt, Tags, Featured Image, Published, Publish Date, Body); update the manual section if "${label}" was intentionally removed from admin/config.yml.`,
        ).toBeVisible({ timeout: 5_000 });
      }
      await captureStep(page, {
        section: "Manual probe — entry form",
        step: `c1-${ctx.line}`,
        title: `Posts edit form fields present (manual line ${ctx.line})`,
        body: "C1 runtime probe: confirms each of the 9 fields documented in the Editing a post section of the manual (Title, URL Slug, Date, Excerpt, Tags, Featured Image, Published, Publish Date, Body) is still rendered when opening a post.",
      });
    },
  },
  {
    match: ["deleting an entry"],
    name: "Delete entry button reachable from a saved entry",
    async run(page, ctx) {
      // Manual claims: "the toolbar's Delete button is only available
      // once the entry exists on disk — the button label is **Delete
      // entry** for unpublished drafts and **Delete published entry**
      // for live posts." We hit the Tags collection and open an
      // existing entry: the seed Tags collection in the local backend
      // has at least one entry on disk, so the toolbar button must
      // render.
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^tags$/i }).click();
      const firstTag = page.locator('a[href*="#/collections/tags/entries/"]').first();
      const tagExists = await firstTag.isVisible({ timeout: 10_000 }).catch(() => false);
      // If no tag entries exist on disk, the manual's delete affordance
      // can't be probed — emit a soft note rather than failing on
      // empty-collection state.
      if (!tagExists) {
        test.info().annotations.push({
          type: "manual-walkthrough",
          description: `Manual section §${ctx.section} (line ${ctx.line}) → no Tags entries on disk; can't probe the Delete toolbar button. Seed at least one tag, or extend this probe to use editorial_workflow with a deterministic seed.`,
        });
        return;
      }
      await firstTag.click();
      const deleteBtn = page
        .getByRole("button", { name: /^delete (entry|published entry)$/i })
        .first();
      await expect(
        deleteBtn,
        `Manual section §${ctx.section} (line ${ctx.line}) → Delete button missing in the toolbar after opening an existing entry. The manual claims the button label is "Delete entry" (drafts) or "Delete published entry" (live posts) but neither matches.`,
      ).toBeVisible({ timeout: 30_000 });
      await captureStep(page, {
        section: "Manual probe — delete",
        step: `c1-${ctx.line}`,
        title: `Delete toolbar button present (manual line ${ctx.line})`,
        body: "C1 runtime probe: confirms the Delete entry / Delete published entry toolbar affordance documented in the Deleting an entry section of the manual still renders.",
      });
    },
  },
  {
    match: ["reviewing visual regressions"],
    name: "Reviews dashboard reachable",
    async run(page, ctx) {
      // Manual claims: "The /admin/reviews/ dashboard shows one card
      // per open visual-regression review. The stat grid summarises
      // how many pages are visually different vs. potentially affected
      // vs. identical." The dashboard page itself loads without auth
      // and renders skeleton + cards. We just confirm the page exists
      // and isn't a 404 / theme bug — the deeper assertions live in
      // `e2e/admin-reviews-stats.spec.js`.
      const response = await page.goto("/admin/reviews/");
      expect(
        response && response.ok(),
        `Manual section §${ctx.section} (line ${ctx.line}) → /admin/reviews/ did not return a 2xx (status: ${response ? response.status() : "no response"}). The manual documents this as a live dashboard.`,
      ).toBeTruthy();
      // The dashboard renders even with no regression data — match the
      // visible "Reviews" / "Visual" header text rather than a class.
      const header = page
        .locator("h1, h2")
        .filter({ hasText: /reviews?|visual/i })
        .first();
      await expect(
        header,
        `Manual section §${ctx.section} (line ${ctx.line}) → /admin/reviews/ rendered but no Reviews/Visual heading is visible. The manual section may need to be updated if the dashboard structure changed.`,
      ).toBeVisible({ timeout: 10_000 });
      await captureStep(page, {
        section: "Manual probe — reviews dashboard",
        step: `c1-${ctx.line}`,
        title: `Reviews dashboard reachable (manual line ${ctx.line})`,
        body: "C1 runtime probe: confirms /admin/reviews/ still loads and renders a Reviews/Visual heading, matching the Reviewing visual regressions section of the manual.",
      });
    },
  },
];

test.describe(
  "@parity Manual walkthrough — CONTRIBUTOR_MANUAL probes",
  // Tagged @admin-screenshots: drives local /admin to capture
  // contributor-manual screenshots. Runs on chromium-desktop-3k ONLY
  // (single-browser by design — `manual-capture.js` writes screenshots
  // to project-INDEPENDENT paths, so two parallel projects would
  // race + last-write-wins). See playwright.config.js.
  { tag: ["@admin-screenshots"] },
  () => {
    // #33 — the contributor walkthrough hard-asserts the full
    // Posts/Tags/Projects/Pages sidebar; a base_collections:[] consumer strips
    // those blocks from config-local.yml, so the walkthrough would time out.
    test.skip(...guard(SITE_ROOT, "manual-walkthrough-contributor.spec.js"));

    test.describe.configure({ mode: "serial", timeout: 300_000 });

    test.beforeEach(({ page }, info) => {
      test.skip(
        info.project.name !== "chromium-desktop-3k",
        "Heavy CMS setup — one project is enough for the manual probe.",
      );
      test.skip(
        TARGET === "prod",
        "Probes drive /admin/index-local.html (local_backend: true). prod has no local proxy, so login can't populate the sidebar.",
      );
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
      // Decap CMS uses native window.confirm() for delete and unpublish
      // confirmations; the contributor probe asserts the Delete button is
      // reachable and may evolve to actually click it (see manual section
      // §"deleting an entry"). Without a persistent listener, Playwright
      // auto-dismisses the dialog and Decap reads it as "user cancelled."
      // See AGENTS.md "Test-Driven Design" section.
      page.on("dialog", (d) => d.accept());
      page.on("console", (msg) => {
        if (msg.type() === "error") console.log(`[console.error] ${msg.text()}`);
      });
    });

    // Read the manual once at module load so a missing-file failure is
    // visible at planning time rather than buried inside a probe.
    let manualMarkdown;
    let sections = [];
    let manualMissing = false;
    let manualSparse = false;
    try {
      manualMarkdown = fs.readFileSync(MANUAL_PATH, "utf8");
      sections = parseManualSections(manualMarkdown);
      manualSparse = isManualSparse(sections);
    } catch {
      manualMissing = true;
    }

    test("@parity manual exists and is non-sparse (or fixme with regen pointer)", async () => {
      if (manualMissing) {
        test.fixme(
          true,
          `${MANUAL_PATH} not found. The manual is auto-generated by MANUAL_CAPTURE=1 runs (see ${REGEN_WORKFLOW}). Regenerate then re-run this spec.`,
        );
        return;
      }
      if (manualSparse) {
        test.fixme(
          true,
          `${MANUAL_PATH} has only ${sections.length} section(s). The manual is auto-generated by MANUAL_CAPTURE=1 runs (see ${REGEN_WORKFLOW}); a sparse manual means the regen workflow hasn't run since the last reset. Trigger ${REGEN_WORKFLOW} (or run MANUAL_CAPTURE=1 npx playwright test --project=chromium-desktop-3k locally) and re-run this spec.`,
        );
        return;
      }
      expect(sections.length, "manual should declare at least 3 sections").toBeGreaterThanOrEqual(
        3,
      );
    });

    // Build one test per parsed section. Sections without a matching
    // probe still land as a passing test that emits a `TODO: add probe`
    // annotation — the scaffolding nudge the plan asks for. That keeps
    // the per-section coverage report honest as the manual grows.
    for (const sec of sections) {
      const probe = findProbe(sec.title);
      const titleLabel = probe
        ? `${probe.name} — §${sec.title} (line ${sec.line})`
        : `TODO: add probe for §${sec.title} (line ${sec.line})`;

      test(`@parity ${titleLabel}`, async ({ page }) => {
        if (manualMissing || manualSparse) {
          test.fixme(true, "Manual is missing or sparse — see the gating test above.");
          return;
        }
        if (!probe) {
          // No probe wired up yet for this section. Emit an annotation so
          // the per-test report carries a stable "this section needs a
          // probe" marker rather than silently passing.
          test.info().annotations.push({
            type: "manual-walkthrough",
            description: `TODO: add probe for §${sec.title} (line ${sec.line} of ${path.relative(REPO_ROOT, MANUAL_PATH)}). Wire one into PROBES in e2e/manual-walkthrough-contributor.spec.js.`,
          });
          return;
        }
        await probe.run(page, { section: sec.title, line: sec.line });
      });
    }
  },
);
