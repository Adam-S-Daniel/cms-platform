// @lane: local — crawls the local /admin shell; @parity-eligible via TARGET=
const { test, expect, TARGET } = require("./base");

// E1 — Admin link crawler.
//
// Walks the admin's collection list and entry editor for every collection
// declared in admin/config-local.yml, harvests every <a href> found, and
// asserts each same-origin URL responds 200 / 302 / 304 (HEAD). Catches
// the "the toolbar grew a link to a /thing that 404s" regression class
// before an editor finds it by clicking.
//
// Tagged @parity so the cross-target matrix (G3) lifts this against
// preview-pr* — but NOT prod. The crawler drives /admin/index-local.html,
// which has `local_backend: true` and only mounts when the local proxy
// is reachable on localhost:8081. On prod that proxy doesn't exist, so
// the Login click never populates the sidebar. The TARGET=prod skip
// below keeps the parity matrix green without losing local coverage.
//
// SPA routes are skipped: Decap is hash-routed (`/admin/index-local.html#/…`),
// and a HEAD against the index path is what actually matters — the hash
// payload is interpreted client-side.

const ADMIN_PATH = "/admin/index-local.html";
const COLLECTIONS = ["posts", "tags", "projects", "pages"];

const ACCEPTED_STATUSES = new Set([200, 302, 304]);

// Known-failing URLs the crawler discovers today, owned by other plan
// units. Each entry MUST cite the unit that turns it green so the
// allowlist stays a TODO list, not a junk drawer. When A1 ships, the
// `/blog/<date>-<slug>/` entry comes out — the crawler then fails loud
// on the same regression next time it sneaks in.
//
// Format: regular expressions matched against the full URL string. Match
// = "skip the HEAD assertion for this URL"; the URL is still surfaced
// in the failure message so a regression of a *different* shape doesn't
// hide behind a sibling allowlist entry.
const KNOWN_BUGS = [
  // Bug B (plan unit A1) — admin/config.yml:55-56's `preview_path:
  // "/blog/{{slug}}/"` collides with `_config.yml:12`'s
  // `permalink: /blog/:slug/` because Decap fills `{{slug}}` with the
  // file-slug template result (date-prefixed). The live-url banner emits
  // /blog/<YYYY>-<MM>-<DD>-<slug>/ which 404s. A1 routes both affordances
  // through window.LiveURL.compute() and this entry can be removed.
  /\/blog\/\d{4}-\d{2}-\d{2}-[^/]+\/?$/,
  // pages/about.md ships with `published: false` but the live-url banner
  // still computes /pages/about/ from its frontmatter `permalink`. The
  // banner's "published === false" branch already guards the URL surface
  // (renders "Not yet published.") — so this 404 means the banner state
  // is detached from the rendered DOM. Belongs to the same A1 / banner
  // code path; remove this entry once `data.published` is plumbed
  // correctly for Pages.
  /\/pages\/about\/?$/,
  // (Removed by #1771 step 4.) An entry here once allowlisted
  // `/blog/e2e-mutation-canary/`, surfaced by the admin link surface
  // from the persistent `_posts/2099-01-01-e2e-mutation-canary.md`
  // canary's front-matter even though it shipped `published: false`.
  // That persistent canary is gone — the prod-mutate loop now uses
  // ephemeral born-published `_posts/2099-12-31-*-<runId>.md` posts that
  // exist only transiently — so the admin no longer advertises that URL
  // and there is nothing left to allowlist (keeping the dead regex would
  // make this a junk drawer, per the header). If a similar surfaced-but-
  // 404ing URL reappears, add a fresh entry with its own rationale.
];

function isKnownBug(url) {
  return KNOWN_BUGS.some((re) => re.test(url));
}

// URLs we deliberately don't crawl. `mailto:`/`javascript:`/bare `#`
// fragments aren't HTTP endpoints; SPA hash routes resolve to the same
// admin shell we're already loading; externals (unpkg, GitHub, etc.) are
// out of scope for this spec — the parity guarantee is "the admin's own
// links work", not "every third-party host on the internet is up".
function shouldSkip(rawHref, adminOrigin) {
  if (!rawHref) return true;
  if (/^mailto:/i.test(rawHref)) return true;
  if (/^javascript:/i.test(rawHref)) return true;
  // Bare or hash-only fragments — `#`, `#foo`, `#/collections/posts`.
  if (/^#/.test(rawHref)) return true;

  let url;
  try {
    url = new URL(rawHref);
  } catch {
    return true;
  }
  if (url.origin !== adminOrigin) return true;
  // Decap's SPA routes — `/admin/index-local.html#/collections/posts/…`.
  // The hash is client-routed; HEAD against the underlying HTML doc is
  // covered separately by the entry-page navigation itself.
  if (url.hash && url.pathname.startsWith("/admin/")) return true;
  return false;
}

// Open the collection's index page and mount the entry editor for the
// first entry, falling back to the New-entry route when the collection is
// empty (e.g. _projects/ ships only an index.html, no Decap entries).
async function openCollectionEditor(page, collection) {
  await page.goto(`${ADMIN_PATH}#/collections/${collection}`);

  // Decap renders entry links as <a href="…#/collections/<name>/entries/<slug>">.
  // Wait briefly for any to appear; if none do, route into the New form
  // to still mount the editor surface.
  const entryLink = page.locator(`a[href*="#/collections/${collection}/entries/"]`).first();
  const haveEntry = await entryLink
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (haveEntry) {
    await entryLink.click();
  } else {
    await page.goto(`${ADMIN_PATH}#/collections/${collection}/new`);
  }

  // Wait until *some* form control mounts. Title is shared across
  // posts / projects / pages; tags has Name. Either way the labelled
  // input proves the editor is up before we harvest hrefs.
  const editorMounted = page.locator('label, h3, h4, legend, input[type="text"], textarea');
  await expect(editorMounted.first()).toBeVisible({ timeout: 60_000 });
}

test.describe(
  "@parity admin link crawler",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 240_000 });

    test.beforeEach(({ page }) => {
      test.skip(
        TARGET === "prod",
        "Crawler drives /admin/index-local.html (local_backend: true). prod has no local proxy, so login can't populate the sidebar.",
      );
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("every <a href> in the admin returns 200/302/304 (HEAD)", async ({ page }) => {
      // ── Login (local-backend skips OAuth) ─────────────────────────────
      await page.goto(ADMIN_PATH);
      const loginBtn = page.getByRole("button", { name: /login/i });
      await expect(loginBtn).toBeVisible({ timeout: 60_000 });
      await loginBtn.click();
      await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({
        timeout: 30_000,
      });

      const adminOrigin = new URL(page.url()).origin;
      const harvested = new Set();

      // Harvest every <a href> reachable from the page right now. Called
      // once per surface (collection list / entry editor) — the de-dup
      // happens in the surrounding Set.
      async function harvest() {
        const hrefs = await page.$$eval("a[href]", (els) => els.map((a) => a.href));
        for (const href of hrefs) harvested.add(href);
      }

      // Walk every declared collection. The loop opens the list, harvests,
      // opens the first entry (or the New form if the folder is empty),
      // harvests again, and moves on.
      for (const collection of COLLECTIONS) {
        await page.goto(`${ADMIN_PATH}#/collections/${collection}`);
        await expect(
          page.getByRole("link", { name: new RegExp(`^${collection}$`, "i") }),
        ).toBeVisible({ timeout: 30_000 });
        await harvest();

        await openCollectionEditor(page, collection);
        await harvest();
      }

      // ── Filter to same-origin, non-SPA URLs and HEAD each one ─────────
      const candidates = Array.from(harvested).filter((href) => !shouldSkip(href, adminOrigin));

      // Belt-and-braces: the harvested set will almost always include at
      // least one same-origin href (the floating Live Preview link points
      // at /preview/). If the filter ever drops to zero, that's a signal
      // the admin shell didn't render — fail loud rather than passing
      // vacuously.
      expect(
        candidates.length,
        "Expected at least one same-origin <a href> to crawl after walking every collection",
      ).toBeGreaterThan(0);

      const failures = [];
      const knownBugHits = [];
      for (const url of candidates) {
        let status;
        try {
          const response = await page.request.fetch(url, {
            method: "HEAD",
            maxRedirects: 0,
          });
          status = response.status();
          if (ACCEPTED_STATUSES.has(status)) continue;
          if (isKnownBug(url)) {
            knownBugHits.push(`${url} → ${status} (allowlisted; see KNOWN_BUGS)`);
            continue;
          }
          failures.push(`${url} → ${status}`);
        } catch (err) {
          failures.push(`${url} → request error: ${err.message}`);
        }
      }

      if (knownBugHits.length) {
        console.log(
          `[cms-link-crawler] known-bug allowlist hits (${knownBugHits.length}):\n  ` +
            knownBugHits.join("\n  "),
        );
      }

      expect(
        failures,
        `Admin links must respond 200/302/304 (HEAD). Failures:\n  ${failures.join("\n  ")}`,
      ).toEqual([]);
    });
  },
);
