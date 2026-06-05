// @lane: local — drives the local /preview/ shell rendered by Jekyll
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");
const { guard } = require("./base-collections-guards");

// SITE_ROOT — the consuming site's repo root (the same value the rest of the
// harness resolves). In a real consumer it equals `__dirname/..`; the #21
// guard-registry meta-proof overrides it to point at a fixture.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

// The expected `.site-logo` text is the consuming site's `_config.yml` `title`
// — NEVER a hardcoded identity (AGENTS.md: "Never hardcode adamdaniel identity").
// Read it from SOURCE so the assertion is correct on adamdaniel.ai AND on the
// fixture-site ("Fixture Site") alike.
function siteTitle() {
  try {
    const cfg = YAML.parse(fs.readFileSync(path.join(SITE_ROOT, "_config.yml"), "utf8")) || {};
    return cfg.title || "";
  } catch (_) {
    return "";
  }
}

// The /preview/ page is the live-preview surface driven by the CMS. It
// renders with the real Jekyll layouts so its styling is always identical
// to the production site by construction. The CMS (or any caller) streams
// draft content via postMessage; this spec asserts the shell's contract
// directly without booting Decap, so it stays fast and hermetic.
//
// Tests are gated to chromium-desktop-3k because the contract is DOM-level,
// not visual — the cross-browser matrix is covered by visual-regression.

test.describe(
  "Live preview shell at /preview/",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    // #21 — a single-page consumer (cms.base_collections:[]) ships no preview.md
    // (so /preview/ 404s) and has no per-collection posts/pages/projects content
    // for the shell to stream. Guard the whole describe via the shared registry
    // on the build-INDEPENDENT isSinglePage capability signal. Full consumer →
    // RUNS (the gem ships the preview layout's posts/pages/projects variants).
    test.skip(...guard(SITE_ROOT, "preview-shell.spec.js"));

    test.beforeEach(async () => {});

    test("serves 200 with the site chrome and preview root", async ({ page }) => {
      const response = await page.goto("/preview/");
      expect(response.status()).toBe(200);
      // Explicit marker so a 404-page fallback (which also wears the default
      // layout and would match `.site-header`/`.site-footer`) can't satisfy
      // this test.
      await expect(page.locator("[data-preview-root]")).toBeAttached();
      // Site-agnostic: the logo is `site.title` from the consuming site's
      // _config.yml, not a hardcoded identity.
      await expect(page.locator(".site-header .site-logo")).toHaveText(siteTitle());
      await expect(page.locator(".site-footer")).toBeVisible();
    });

    test("defaults to the post layout and exposes named slots", async ({ page }) => {
      await page.goto("/preview/");
      // Active variant is kept; other variants are stripped from the DOM so
      // selectors like `.post-header h1` resolve unambiguously and the
      // document reflects only the real layout.
      await expect(page.locator('[data-preview-layout="posts"]')).toBeAttached();
      await expect(page.locator('[data-preview-layout="pages"]')).toHaveCount(0);
      await expect(page.locator('[data-preview-layout="projects"]')).toHaveCount(0);
      await expect(page.locator(".post-header h1")).toBeAttached();
      await expect(page.locator(".post-content")).toBeAttached();
      // Body is empty by default — the CMS is expected to populate it.
      await expect(page.locator(".post-content")).toHaveText("");
    });

    test("switches to the page layout when ?collection=pages", async ({ page }) => {
      await page.goto("/preview/?collection=pages");
      await expect(page.locator('[data-preview-layout="pages"]')).toBeAttached();
      await expect(page.locator('[data-preview-layout="posts"]')).toHaveCount(0);
      await expect(page.locator(".page-header h1")).toBeAttached();
      await expect(page.locator(".page-content")).toBeAttached();
    });

    test("switches to the project layout when ?collection=projects", async ({ page }) => {
      await page.goto("/preview/?collection=projects");
      await expect(page.locator('[data-preview-layout="projects"]')).not.toHaveAttribute(
        "hidden",
        "",
      );
      // Project layout uses .post-header too, but scoped under the active variant.
      await expect(page.locator('[data-preview-layout="projects"] .post-header h1')).toBeAttached();
      await expect(
        page.locator('[data-preview-layout="projects"] [data-preview-slot="technology"]'),
      ).toBeAttached();
      await expect(
        page.locator('[data-preview-layout="projects"] [data-preview-slot="project-link"]'),
      ).toBeAttached();
    });

    test("emits cms-preview-ready on load so callers know to start streaming", async ({ page }) => {
      await page.goto("/preview/");
      const received = await page.evaluate(
        () =>
          new Promise((resolve) => {
            // The shell posts `cms-preview-ready` to its opener/parent on load;
            // on a top-level nav we echo it back to the same window so tests
            // can observe it without an opener setup.
            const existing = window.__cmsPreviewReady;
            if (existing) return resolve(existing);
            window.addEventListener(
              "message",
              (e) => {
                if (e.data?.type === "cms-preview-ready") resolve(e.data);
              },
              { once: true },
            );
            // Force the shell to re-emit via its documented API so the test
            // doesn't race the initial emit.
            window.__cmsPreviewEmitReady?.();
          }),
      );
      expect(received.type).toBe("cms-preview-ready");
    });

    test("postMessage cms-preview-update replaces title and body", async ({ page }) => {
      await page.goto("/preview/");
      await page.evaluate(() => {
        window.postMessage(
          {
            type: "cms-preview-update",
            fields: {
              title: "My draft headline",
              body: "Hello **world** from the editor.",
            },
          },
          window.location.origin,
        );
      });
      await expect(page.locator(".post-header h1")).toHaveText("My draft headline");
      await expect(page.locator(".post-content strong")).toHaveText("world");
    });

    test("subsequent updates overwrite previous content (no appending)", async ({ page }) => {
      await page.goto("/preview/");
      await page.evaluate(() => {
        window.postMessage(
          {
            type: "cms-preview-update",
            fields: { title: "First", body: "One" },
          },
          window.location.origin,
        );
      });
      await expect(page.locator(".post-header h1")).toHaveText("First");

      await page.evaluate(() => {
        window.postMessage(
          {
            type: "cms-preview-update",
            fields: { title: "Second", body: "Two" },
          },
          window.location.origin,
        );
      });
      await expect(page.locator(".post-header h1")).toHaveText("Second");
      await expect(page.locator(".post-content")).toContainText("Two");
      await expect(page.locator(".post-content")).not.toContainText("One");
    });

    test("post layout: featured_image, date, reading_time, tags all render", async ({ page }) => {
      await page.goto("/preview/?collection=posts");
      await page.evaluate(() => {
        window.postMessage(
          {
            type: "cms-preview-update",
            fields: {
              title: "Tagged post",
              body: "# Section\n\nSome body.",
              featured_image: "/assets/images/uploads/placeholder.svg",
              date: "2026-04-19 12:00:00 +0000",
              tags: ["ai", "python"],
            },
          },
          window.location.origin,
        );
      });
      await expect(page.locator(".post-header .featured-image")).toHaveAttribute(
        "src",
        /placeholder\.svg$/,
      );
      await expect(page.locator(".post-date")).toContainText("2026");
      await expect(page.locator(".post-tags .tag-pill")).toHaveText(["ai", "python"]);
      await expect(page.locator(".post-reading-time")).toContainText("min read");
      await captureStep(page, {
        section: "Real-layout preview",
        step: "4.2",
        title: "Post layout preview with all metadata",
        body: "The `/preview/` shell renders drafts inside the real post layout: featured image, date, reading time, and tags all show up exactly as they will on the live site. There is no theme-switching shortcut — what the preview shows is what the public page will look like.",
      });
    });

    test("project layout: technology and url_link render", async ({ page }) => {
      await page.goto("/preview/?collection=projects");
      await page.evaluate(() => {
        window.postMessage(
          {
            type: "cms-preview-update",
            fields: {
              title: "Cool tool",
              technology: "Rust · Tokio",
              url_link: "https://example.com",
              description: "A thing.",
              featured: true,
            },
          },
          window.location.origin,
        );
      });
      await expect(page.locator('[data-preview-slot="technology"]')).toHaveText("Rust · Tokio");
      await expect(page.locator('[data-preview-slot="project-link"]')).toHaveAttribute(
        "href",
        "https://example.com",
      );
    });

    test("ignores messages from other origins", async ({ page }) => {
      await page.goto("/preview/");
      // Seed something valid first so we can assert it doesn't get clobbered.
      await page.evaluate(() => {
        window.postMessage(
          { type: "cms-preview-update", fields: { title: "Kept" } },
          window.location.origin,
        );
      });
      await expect(page.locator(".post-header h1")).toHaveText("Kept");

      // Synthesize a message as if from another origin. MessageEvent's origin
      // is read-only from page script, but the shell's listener should also
      // bail on messages without `type: 'cms-preview-update'` — exercise both
      // guards.
      await page.evaluate(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "something-else", fields: { title: "Ignored" } },
            origin: window.location.origin,
          }),
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "cms-preview-update", fields: { title: "Foreign" } },
            origin: "https://evil.example.com",
          }),
        );
      });
      await expect(page.locator(".post-header h1")).toHaveText("Kept");
    });

    test("markdown renders images, lists, and code blocks", async ({ page }) => {
      await page.goto("/preview/");
      await page.evaluate(() => {
        window.postMessage(
          {
            type: "cms-preview-update",
            fields: {
              title: "Rich",
              body: "- one\n- two\n\n![alt](/x.png)\n\n```\ncode block\n```\n",
            },
          },
          window.location.origin,
        );
      });
      await expect(page.locator(".post-content ul li").first()).toHaveText("one");
      await expect(page.locator(".post-content img")).toHaveAttribute("alt", "alt");
      await expect(page.locator(".post-content pre code")).toContainText("code block");
    });

    test("robots noindex — preview is not indexable", async ({ page }) => {
      await page.goto("/preview/");
      const robots = await page.locator('meta[name="robots"]').getAttribute("content");
      expect(robots).toMatch(/noindex/i);
    });

    test("BroadcastChannel: updates sent from another same-origin tab apply", async ({
      page,
      context,
    }) => {
      await page.goto("/preview/");

      // A second same-origin page simulates the admin tab broadcasting an
      // update; BroadcastChannel is the transport the CMS bridge uses so a
      // single channel name connects editor and preview without the editor
      // needing to hold a window reference to the preview tab.
      const sender = await context.newPage();
      await sender.goto("/preview/"); // any same-origin doc is fine
      await sender.evaluate(() => {
        const ch = new BroadcastChannel("adamdaniel-cms-preview");
        ch.postMessage({
          type: "cms-preview-update",
          fields: { title: "From broadcast", body: "Channel body" },
        });
        ch.close();
      });

      await expect(page.locator(".post-header h1")).toHaveText("From broadcast");
      await expect(page.locator(".post-content")).toContainText("Channel body");
      await sender.close();
    });
  },
);
