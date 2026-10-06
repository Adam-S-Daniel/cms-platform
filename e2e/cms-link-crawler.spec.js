// @lane: local — crawls the local /admin shell; @parity-eligible via TARGET=
const { test, expect, TARGET } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { guard } = require("./base-collections-guards");
const { slugify } = require("./public-content");
// SITE_ROOT for the #33 base_collections guard (build-INDEPENDENT source signal).
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

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

// Public links to entries the served site was never built with.
//
// The local webServer serves a `_site` built at startup (and rebuilt only
// when a spec runs jekyll-build.js), while decap-server reads and writes the
// live working tree. The newest build's `_site/index.html` mtime is the
// cut-off: a source written after it is not in what is served. Other specs in
// the same run create entries through the CMS (cms-html-embed's
// `e2e-html-embed` post, cms-smoke's `decap-smoke-test` tag, …), so the
// admin lists entries the static site has no page for. Since #682 the
// admin's public links (the posts list's "published ↗", the live-URL
// banner) use the served config's site_url, which locally is this same
// origin, so the crawler HEADs them and gets a 404 that says nothing about
// the admin: the entry simply postdates the build. Which entries exist at
// crawl time depends on what ran before, hence the intermittent red.
//
// Such a link is out of scope only when ALL of these hold, so a real
// regression still fails: the status is 404; the URL is exactly the public
// URL this spec derives for an entry the admin listed (a link with the
// wrong shape, e.g. KNOWN_BUGS' date-prefixed slug, never matches); and
// that entry's source is missing or newer than the build. A built entry
// whose derived URL 404s (the admin and Jekyll disagreeing on the URL)
// is still a failure.
const PUBLIC_ENTRY_ROUTES = {
  // config's `permalink: /blog/:slug/`: Jekyll drops the date prefix and
  // slugifies the rest (same derivation as posts-list-enhance.js urlSlug).
  posts: { folder: "_posts", urlPath: (slug) => `/blog/${slugify(slug.replace(/^\d{4}-\d{2}-\d{2}-/, ""))}/` },
  // tags collection: `permalink: /tags/:slug/`.
  tags: { folder: "_tags", urlPath: (slug) => `/tags/${slugify(slug)}/` },
};

function unbuiltEntryUrls(adminHrefs, adminOrigin) {
  const urls = new Set();
  if (TARGET !== "local") return urls;
  let builtAt;
  try {
    builtAt = fs.statSync(path.join(SITE_ROOT, "_site", "index.html")).mtimeMs;
  } catch {
    return urls; // no local build to compare against
  }
  for (const href of adminHrefs) {
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    // Decap's entry route, `/admin/index-local[.html]#/collections/<c>/entries/<slug>`.
    if (url.origin !== adminOrigin || !url.pathname.startsWith("/admin/")) continue;
    const m = /^#\/collections\/([^/]+)\/entries\/([^/?#]+)$/.exec(url.hash);
    const route = m && Object.hasOwn(PUBLIC_ENTRY_ROUTES, m[1]) && PUBLIC_ENTRY_ROUTES[m[1]];
    if (!route) continue;
    let slug;
    try {
      slug = decodeURIComponent(m[2]);
    } catch {
      continue;
    }
    if (slug.includes("/") || slug.includes("..")) continue;
    let unbuilt;
    try {
      unbuilt = fs.statSync(path.join(SITE_ROOT, route.folder, `${slug}.md`)).mtimeMs > builtAt;
    } catch {
      unbuilt = true; // deleted since the admin listed it: a transient spec entry
    }
    if (unbuilt) urls.add(`${adminOrigin}${route.urlPath(slug)}`);
  }
  return urls;
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
    // #33 — a base_collections:[] consumer strips the Posts block from
    // config-local.yml, so the crawler's wait for the Posts sidebar link
    // would time out. Skip unless posts is kept.
    test.skip(...guard(SITE_ROOT, "cms-link-crawler.spec.js"));

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
        // The open entry's own route, for unbuiltEntryUrls(): an entry
        // created after the list was harvested is still known here.
        harvested.add(page.url());
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

      const unbuilt = unbuiltEntryUrls(harvested, adminOrigin);
      const failures = [];
      const knownBugHits = [];
      const unbuiltHits = [];
      for (const url of candidates) {
        let status;
        try {
          const response = await page.request.fetch(url, {
            method: "HEAD",
            maxRedirects: 0,
          });
          status = response.status();
          if (ACCEPTED_STATUSES.has(status)) continue;
          if (status === 404 && unbuilt.has(url)) {
            unbuiltHits.push(`${url} → 404 (entry postdates the site build; see unbuiltEntryUrls)`);
            continue;
          }
          if (isKnownBug(url)) {
            knownBugHits.push(`${url} → ${status} (allowlisted; see KNOWN_BUGS)`);
            continue;
          }
          failures.push(`${url} → ${status}`);
        } catch (err) {
          failures.push(`${url} → request error: ${err.message}`);
        }
      }

      if (unbuiltHits.length) {
        console.log(
          `[cms-link-crawler] links to entries the served site was built without (${unbuiltHits.length}):\n  ` +
            unbuiltHits.join("\n  "),
        );
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
