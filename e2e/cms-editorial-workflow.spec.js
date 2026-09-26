// @lane: local — drives the in-browser test-repo backend; never touches real GitHub
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");
const { publishedSwitch } = require("./cms-editor-ui");
const YAML = require("yaml");
const path = require("node:path");
const { guard } = require("./base-collections-guards");
// SITE_ROOT for the #33 base_collections guard (build-INDEPENDENT source signal).
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

// Editorial-workflow + GitHub-style backend e2e coverage.
//
// Why this exists: cms-smoke and cms-publish-flow both drive
// admin/index-local.html, which sets `local_backend: true`.
// Decap's local backend forces SIMPLE MODE regardless of
// `publish_mode: editorial_workflow` (cms-publish-flow.spec.js:19-22).
// That means the entire editorial-workflow code path — load an
// EXISTING entry, render the form for that entry, fire the
// per-field disabled gate, route Save through the workflow
// instead of straight-to-disk — has zero coverage. A regression
// where every field opens read-only in production is invisible
// to those tests.
//
// This spec uses Decap's official `test-repo` backend
// (admin/config-test.yml + admin/index-test.html) with
// editorial_workflow ON. The test-repo backend runs entirely
// in-browser and reads its initial file tree from the globals
// `window.repoFiles` and `window.repoFilesUnpublished`, which
// we seed via Playwright's `addInitScript` — so the editor
// mounts on a deterministic repo state every run.
//
// Source for the seeding shape:
//   https://github.com/decaporg/decap-cms/blob/main/packages/decap-cms-backend-test/src/implementation.ts
//   https://github.com/decaporg/decap-cms/blob/main/dev-test/index.html

const SEED_POST_SLUG = "2026-04-25-replacement-test-post-1";
const SEED_POST_TITLE = "Replacement test post 1";
const RESERVED_PREVIEW_ORIGIN = "https://preview-pr0.example.com";
const RESERVED_CANONICAL_HOST = "example.com";
const PREVIEW_PROBE_BRANCH = "preview-hostname-browser-probe";

// Front matter intentionally mirrors the real entry the bug was
// reported against — empty-string `slug`, `excerpt`, `featured_image`,
// `publish_date`; null `reading_time`. If any of those values trip
// a widget into a stuck/disabled state, this spec catches it.
const SEED_POST_CONTENT = `---
title: ${SEED_POST_TITLE}
slug: ''
date: 2026-04-25 16:33:00 -0400
excerpt: ''
tags: []
featured_image: ''
published: true
publish_date: ''
reading_time: null
---

Wow, a post
`;

// Decap's test-repo backend reads `window.repoFiles` recursively
// (top-level keys → folders, leaf objects → `{ content }`). We
// seed exactly the file under test plus the empty collection
// folders so the dashboard renders without 404 noise.
function buildSeed({ postContent = SEED_POST_CONTENT } = {}) {
  return {
    repoFiles: {
      _posts: {
        "2026-04-25-replacement-test-post-1.md": {
          content: postContent,
        },
      },
      _tags: {},
      _projects: {},
      pages: {},
    },
    // No open editorial-workflow drafts — entry is fully published,
    // so opening it should land on the editable published-entry view
    // with the "Delete published entry" button rendered.
    repoFilesUnpublished: [],
  };
}

async function loadAdmin(page, options) {
  const seed = buildSeed(options);
  // Run BEFORE any document scripts — Decap reads window.repoFiles
  // at backend-initialise time. addInitScript fires on each new
  // browsing context; serialised JSON keeps the data stable.
  await page.addInitScript((seedJson) => {
    const s = JSON.parse(seedJson);
    window.repoFiles = s.repoFiles;
    window.repoFilesUnpublished = s.repoFilesUnpublished;
  }, JSON.stringify(seed));

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[console.error] ${msg.text()}`);
  });

  await page.goto("/admin/index-test.html");

  // test-repo backend renders a "Login" button identical to local_backend.
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();

  // Collections sidebar mounts when the repo is ready.
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({
    timeout: 30_000,
  });
}

function asTestRepoConfig(source, shellOrigin) {
  const config = YAML.parse(source) || {};
  config.backend = { name: "test-repo", branch: PREVIEW_PROBE_BRANCH };
  config.publish_mode = "editorial_workflow";
  config.site_url = shellOrigin;
  config.display_url = shellOrigin;
  delete config.local_backend;
  return YAML.stringify(config);
}

function replaceInjectedCanonicalHost(html) {
  return html
    .replace(
      /window\.CMS_SITE_ORIGIN=(?:"(?:[^"\\]|\\.)*"|null);/,
      'window.CMS_SITE_ORIGIN="https://example.com";',
    )
    .replace(
      /window\.CMS_APEX=(?:"(?:[^"\\]|\\.)*"|null);/,
      `window.CMS_APEX="${RESERVED_CANONICAL_HOST}";`,
    );
}

async function loadPreviewProductionAdmin(page, baseURL) {
  const target = (process.env.TARGET || "local").toLowerCase();
  const local = target === "local";
  const shellOrigin = local ? RESERVED_PREVIEW_ORIGIN : new URL(baseURL).origin;

  if (local) {
    const upstreamOrigin = new URL(baseURL).origin;
    await page.route(`${RESERVED_PREVIEW_ORIGIN}/**`, async (route) => {
      const requested = new URL(route.request().url());
      const upstream = new URL(requested.pathname + requested.search, upstreamOrigin);
      const response = await route.fetch({ url: upstream.href });
      if (requested.pathname === "/admin/config.yml") {
        const body = asTestRepoConfig(await response.text(), shellOrigin);
        await route.fulfill({ response, body });
      } else if (requested.pathname === "/admin/index.html") {
        const body = replaceInjectedCanonicalHost(await response.text());
        await route.fulfill({ response, body });
      } else {
        await route.fulfill({ response });
      }
    });
  } else {
    await page.route("**/admin/config.yml", async (route) => {
      const response = await route.fetch();
      const body = asTestRepoConfig(await response.text(), shellOrigin);
      await route.fulfill({ response, body });
    });
  }

  const seed = buildSeed();
  await page.addInitScript((seedJson) => {
    const parsed = JSON.parse(seedJson);
    window.repoFiles = parsed.repoFiles;
    window.repoFilesUnpublished = parsed.repoFilesUnpublished;
  }, JSON.stringify(seed));

  await page.goto(`${shellOrigin}/admin/index.html`);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.goto(
    `${shellOrigin}/admin/index.html#/collections/posts/entries/${SEED_POST_SLUG}`,
  );
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
  return { shellOrigin, currentHost: new URL(shellOrigin).hostname };
}

test.describe(
  "Decap editorial workflow — existing-entry editor is editable",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test.beforeEach(async () => {});

    // ── Regression test for the read-only-form bug ─────────────────────
    //
    // Reported state: every field on /admin/#/collections/posts/entries/
    // <slug> renders read-only and the "Delete published entry" button
    // is disabled.
    //
    // Decap implements per-field disabling by injecting
    // `pointer-events: none; opacity: 0.5` onto each widget wrapper
    // (EditorControl.js: styleStrings.disabled). That style is the
    // ONLY way the core EditorControlPane produces a form-wide
    // disabled appearance, and it fires when isDisabled prop is true
    // (driven by `isFieldDuplicate` — typically i18n-related).
    //
    // We assert against the actual style + the toolbar button
    // states, since both modes (CSS-disabled and DOM-disabled)
    // feel equally broken to an editor.
    test("opening an existing post renders all fields editable + Delete button enabled", async ({
      page,
    }) => {
      await loadAdmin(page);

      // Drive directly to the entry URL the user reported the bug on.
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);

      // Title is the canary — if Decap can't mount the form for this
      // entry at all, this fails fast with a clear message.
      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await expect(titleField).toBeEnabled();
      await expect(titleField).toHaveValue(SEED_POST_TITLE);
      await captureStep(page, {
        section: "Editing a post",
        step: "3.2",
        title: "Open an existing post in the editorial workflow",
        body: "Editorial workflow mode loads the existing entry into a fully editable form. Every widget — Title, URL Slug, Date, Body, Tags, Featured Image — is enabled.",
      });

      // ── Per-widget disabled-style audit ───────────────────────────────
      // Walk every widget wrapper in the form and assert NONE of them
      // carry pointer-events:none / opacity ≤ 0.5. If the bug ever
      // re-appears, the failure points at the exact widget that's
      // locked rather than just "form is broken somewhere".
      const widgetReport = await page.evaluate(() => {
        // Decap wraps each field in a div with class containing
        // "ControlContainer". The disabled class injects inline
        // `pointer-events: none; opacity: 0.5` (see styleStrings.disabled
        // in decap-cms-core's EditorControl.js).
        const wrappers = Array.from(document.querySelectorAll('[class*="ControlContainer"]'));
        return wrappers.map((el) => {
          const cs = getComputedStyle(el);
          // The label text is the most useful identifier for failures.
          const labelEl = el.querySelector("label, h3, h4, legend");
          const label = labelEl ? labelEl.textContent.trim() : "(unknown field)";
          return {
            label,
            pointerEvents: cs.pointerEvents,
            opacity: parseFloat(cs.opacity),
          };
        });
      });
      expect(
        widgetReport.length,
        "EditorControlPane should render at least one widget wrapper",
      ).toBeGreaterThan(0);
      for (const w of widgetReport) {
        expect(
          w.pointerEvents,
          `Widget "${w.label}" should accept pointer events (got pointer-events: ${w.pointerEvents}). This is the exact CSS Decap injects when EditorControlPane passes isDisabled=true.`,
        ).not.toBe("none");
        expect(
          w.opacity,
          `Widget "${w.label}" should render at full opacity (got ${w.opacity}). Decap's disabled style sets opacity: 0.5.`,
        ).toBeGreaterThan(0.6);
      }

      // ── Toolbar button audit ──────────────────────────────────────────
      // "Delete published entry" should render AND be clickable. In
      // editorial_workflow mode with no open draft, Decap shows that
      // exact label (EditorToolbar.js: deletePublishedEntry).
      const deleteBtn = page.getByRole("button", {
        name: /delete published entry/i,
      });
      await expect(deleteBtn).toBeVisible();
      await expect(deleteBtn).toBeEnabled();

      // Save button can be `disabled={!hasChanged}` on initial load —
      // that's expected. Type one character and assert it goes live.
      await titleField.click();
      await titleField.press("End");
      await titleField.type(" (edited)");
      const saveBtn = page.getByRole("button", { name: /^save$/i }).first();
      await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    });

    // ── Edit + Save round-trip ─────────────────────────────────────────
    //
    // Closes the "tests never edit existing entries" gap. Drives the
    // form, saves, then asserts the change landed in the test backend
    // (workflow draft) — which is exactly what production would do.
    test("editing an existing post and saving creates a workflow draft", async ({ page }) => {
      await loadAdmin(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });

      const NEW_TITLE = `${SEED_POST_TITLE} — edited by spec`;
      await titleField.fill(NEW_TITLE);

      await captureStep(page, {
        section: "Marking ready and publishing",
        step: "5.1",
        title: "Save in editorial workflow",
        body: "With `publish_mode: editorial_workflow`, the toolbar's primary action is **Save** rather than Publish. The first Save creates a `cms/posts/<slug>` branch and opens a PR; subsequent Saves push commits onto that branch. The PR appears with the `cms/draft` label and stays in draft until you change the Status.",
      });
      // Save → with editorial_workflow on, Decap routes this into a
      // draft (Status: draft), NOT a publish. Button label is "Save"
      // not "Publish" in workflow mode.
      await page
        .getByRole("button", { name: /^save$/i })
        .first()
        .click();

      // Wait for the in-memory backend to register the unpublished
      // draft. The test-repo backend stores workflow entries on
      // window.repoFilesUnpublished keyed by `${collection}/${slug}`.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const map = window.repoFilesUnpublished || {};
              const key = `posts/${"2026-04-25-replacement-test-post-1"}`;
              const entry = map[key];
              if (!entry || !entry.diffs || !entry.diffs.length) return null;
              return entry.diffs[0].content;
            }),
          { timeout: 30_000 },
        )
        .toContain(NEW_TITLE);
    });

    test("editing a title preserves an existing explicit website path", async ({ page }) => {
      const explicitSlug = "kept-explicit-website-path";
      const postContent = SEED_POST_CONTENT.replace("slug: ''", `slug: ${explicitSlug}`);
      await loadAdmin(page, { postContent });
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      const slugField = page.getByRole("textbox", {
        name: /^URL Slug(?: \(optional\))?$/i,
      });
      await expect(slugField).toBeVisible();
      await expect(slugField).toBeEditable();
      await expect(slugField).toHaveValue(explicitSlug);

      const editedTitle = "A completely different replacement title";
      await titleField.fill(editedTitle);
      await expect(page.getByTestId("cms-live-url-banner-link")).toHaveAttribute(
        "href",
        new RegExp(`/blog/${explicitSlug}/$`),
      );
      await page.getByRole("button", { name: /^save$/i }).first().click();

      let saved = null;
      await expect
        .poll(
          async () => {
            saved = await page.evaluate(
              (slug) =>
                window.repoFilesUnpublished?.[`posts/${slug}`]?.diffs?.[0]?.content || null,
              SEED_POST_SLUG,
            );
            return saved;
          },
          { timeout: 30_000 },
        )
        .toContain(editedTitle);
      const frontMatter = saved.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(frontMatter, "saved entry should retain YAML front matter").not.toBeNull();
      expect(YAML.parse(frontMatter[1]).slug).toBe(explicitSlug);
    });

    test("preview editor names its preview and canonical hosts in the UI", async (
      { page, baseURL },
      testInfo,
    ) => {
      test.skip(
        (process.env.TARGET || "local").toLowerCase() === "prod",
        "hostname preview contract requires a preview origin",
      );
      // The production shell renders config.yml, which honours the consumer's
      // cms.base_collections keep-list — no Posts link on an opted-out site.
      test.skip(...guard(SITE_ROOT, "cms-editorial-workflow.spec.js"));

      const { currentHost } = await loadPreviewProductionAdmin(page, baseURL);
      const identity = await page.evaluate(() => ({
        current: window.CMSHostname.current(),
        canonical: window.CMSHostname.canonical(),
      }));
      expect(identity.current).toBe(currentHost);
      if ((process.env.TARGET || "local").toLowerCase() === "local") {
        expect(identity.current).toBe("preview-pr0.example.com");
        expect(identity.canonical).toBe(RESERVED_CANONICAL_HOST);
      }

      const slugField = page.getByRole("textbox", {
        name: /^URL Slug(?: \(optional\))?$/i,
      });
      await expect(slugField).toBeVisible();
      await expect(slugField).toBeEditable();
      const slugControl = slugField.locator(
        'xpath=ancestor::div[contains(@class,"ControlContainer")][1]',
      );
      await expect(slugControl).toContainText(`URL path on ${currentHost}`);

      const published = publishedSwitch(page);
      const publishedControl = published.locator(
        'xpath=ancestor::div[contains(@class,"ControlContainer")][1]',
      );
      await expect(publishedControl).toContainText(
        `Turn on to show this post on ${currentHost} when you select Publish.`,
      );

      const publishDate = page.getByLabel(/^Publish Date/);
      const publishDateControl = publishDate.locator(
        'xpath=ancestor::div[contains(@class,"ControlContainer")][1]',
      );
      await expect(publishDateControl).toContainText(
        `publish this post automatically on ${currentHost}`,
      );

      const liveURL = page.getByTestId("cms-live-url-banner-link");
      await expect(liveURL).toBeVisible();
      await expect(liveURL).toContainText(currentHost);

      const previewWarning = page.locator("#cms-branch-binding-banner");
      await expect(previewWarning).toBeVisible();
      await expect(previewWarning).toContainText(currentHost);
      await expect(previewWarning).toContainText(identity.canonical);

      const screenshot = testInfo.outputPath("preview-hostname-editor.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach("preview hostname editor", {
        path: screenshot,
        contentType: "image/png",
      });
    });

    // ── Create-new through the workflow ────────────────────────────────
    //
    // Mirrors what production does on every editor "New post" click:
    // the entry lands on a `cms/<collection>/<slug>` branch and opens
    // a PR. Tags is the simplest collection schema (name + description),
    // so we use it for the speed; the persistEntry code path is shared
    // across all collections.
    test("creating a new tag through the editorial workflow", async ({ page }) => {
      await loadAdmin(page);
      await page.goto("/admin/index-test.html#/collections/tags/new");

      const NEW_TAG_NAME = "Editorial Workflow Smoke";
      const NEW_TAG_SLUG = "editorial-workflow-smoke";

      const nameField = page.getByLabel(/^Name$/);
      await expect(nameField).toBeVisible({ timeout: 60_000 });
      await expect(nameField).toBeEnabled();
      await nameField.fill(NEW_TAG_NAME);

      // In editorial workflow, the primary toolbar button is "Save"
      // (writes to the workflow draft branch). Simple mode shows
      // "Publish" with a split menu instead.
      await page
        .getByRole("button", { name: /^save$/i })
        .first()
        .click();

      await expect
        .poll(
          () =>
            page.evaluate((slug) => {
              const map = window.repoFilesUnpublished || {};
              const key = `tags/${slug}`;
              const entry = map[key];
              if (!entry || !entry.diffs || !entry.diffs.length) return null;
              return entry.diffs[0].content;
            }, NEW_TAG_SLUG),
          { timeout: 30_000 },
        )
        .toContain(`name: ${NEW_TAG_NAME}`);
    });

    // ── Status dropdown drives Draft → In Review → Ready ──────────────
    //
    // Each pick rewrites the unpublished entry's `status` field — the
    // same field the cms/draft / cms/ready PR labels are derived from in
    // cms-editorial-workflow.yml. Decap's internal keys are
    // "draft" | "pending_review" | "pending_publish".
    test("Status dropdown cycles Draft → In Review → Ready on the saved draft", async ({
      page,
    }) => {
      await loadAdmin(page);
      await page.goto("/admin/index-test.html#/collections/tags/new");
      const NEW_TAG_NAME = "Status Cycle Tag";
      const NEW_TAG_SLUG = "status-cycle-tag";
      const nameField = page.getByLabel(/^Name$/);
      await expect(nameField).toBeVisible({ timeout: 60_000 });
      await nameField.fill(NEW_TAG_NAME);
      await page
        .getByRole("button", { name: /^save$/i })
        .first()
        .click();

      const readStatus = (slug) =>
        page.evaluate((s) => window.repoFilesUnpublished?.[`tags/${s}`]?.status, slug);

      // Wait for the workflow draft to land — initial status is "draft".
      await expect.poll(() => readStatus(NEW_TAG_SLUG), { timeout: 30_000 }).toBe("draft");

      const STATUS_FLOW = [
        { menuLabel: /in review/i, expected: "pending_review" },
        { menuLabel: /ready/i, expected: "pending_publish" },
        { menuLabel: /^draft$/i, expected: "draft" },
      ];
      for (const step of STATUS_FLOW) {
        // Decap renders the Status control as a DropdownButton whose label
        // is the i18n template "Status: %{status}". Match on the prefix so
        // we don't have to know the current status before each click.
        const trigger = page.getByText(/^Status:\s/i).first();
        await expect(trigger).toBeVisible({ timeout: 15_000 });
        await trigger.click();
        const menuItem = page.getByRole("menuitem", { name: step.menuLabel }).first();
        await expect(menuItem).toBeVisible({ timeout: 5_000 });
        await menuItem.click();
        await expect.poll(() => readStatus(NEW_TAG_SLUG), { timeout: 10_000 }).toBe(step.expected);
      }
    });

    // ── Diagnostic banner self-verification ────────────────────────────
    //
    // admin/index-test.html ships its own status banner that walks the
    // rendered DOM and reports EDITABLE / FIELDS DISABLED. The whole
    // point of that banner is letting a non-developer (the site owner)
    // hit a single URL and immediately see whether the rendering path
    // is healthy on their environment. If we ever ship a regression
    // that visually appears fine but disables widgets — the exact
    // mode of the read-only bug — the banner must catch it.
    test("diagnostic banner reports EDITABLE on the seeded post", async ({ page }) => {
      await loadAdmin(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });

      // The banner inspects on every MutationObserver tick + every
      // hashchange. Wait for it to settle on a non-PENDING verdict.
      const badge = page.locator("#cms-diagnostic-status");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(/^EDITABLE$/i, { timeout: 30_000 });
      await expect(badge).toHaveClass(/green/);
    });
  },
);
