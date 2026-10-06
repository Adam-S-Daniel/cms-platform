// @lane: local — cross-check that admin/live-url-derive.js's compute()
// hides the "VIEW PAGE ON SITE" banner on collections with no derivable
// route (cms-platform#328.3), by loading the REAL browser IIFE in a vm
// sandbox and exercising compute() directly — not a regex over the source.
//
// The bug: "Set a title or slug to see the URL" showed on EVERY entry of
// EVERY collection outside {posts, tags, projects, pages} — including
// entries with a filled title, and on file/singleton collections
// (Header/Hero, Site Settings) that will never have their own page — because
// compute() always returned `{ url: null }` for those, and
// live-url-banner.js's render() renders that as the unactionable hint
// rather than hiding the banner. The fix: compute() now returns `null`
// outright for a non-routable collection, which render()'s `if (!data)`
// branch already hides entirely (see live-url-banner.js).

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVE_URL_DERIVE_PATH = path.join(REPO_ROOT, "theme", "admin", "live-url-derive.js");

// A minimal DOM stub sufficient for compute(): readField() looks up one
// element by the `id^="<name>-field"` selector Decap actually renders;
// readPublished() walks `document.querySelectorAll("*")` looking for a
// "Published" toggle, which we don't need for these cases (an empty list
// makes it correctly return null == "no Published toggle in this schema").
function loadLiveURL(fields, { access = "https://example.com", siteURL } = {}) {
  const src = fs.readFileSync(LIVE_URL_DERIVE_PATH, "utf8");
  const els = {};
  for (const [name, value] of Object.entries(fields || {})) {
    els[name] = { value };
  }
  const sandbox = {
    window: { location: new URL(access + "/admin/"), CMS_SITE_ORIGIN: "https://example.com" },
    URL,
    Promise,
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve(`site_url: ${siteURL}\n`) }),
    document: {
      readyState: "loading",
      addEventListener() {},
      querySelector(sel) {
        const m = /id\^="([^"]+)-field"/.exec(sel);
        if (!m) return null;
        return els[m[1]] || null;
      },
      querySelectorAll() {
        return []; // no Published toggle in the fixture — treated as always-live
      },
    },
  };
  vm.createContext(sandbox);
  if (siteURL) vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, "theme/admin/site-hostname.js"), "utf8"), sandbox);
  vm.runInContext(src, sandbox);
  expect(
    sandbox.window.LiveURL && typeof sandbox.window.LiveURL.compute,
    "admin/live-url-derive.js must expose window.LiveURL.compute",
  ).toBe("function");
  return { LiveURL: sandbox.window.LiveURL, window: sandbox.window };
}

test.describe("live-url-derive.js compute() — routable-collection gate (#328.3)", () => {
  test("returns null for a file/singleton collection (e.g. Header/Hero) even with a filled title", () => {
    const { LiveURL, window } = loadLiveURL({ title: "My Tagline" });
    window.location.hash = "#/collections/header/entries/header";
    expect(
      LiveURL.compute(),
      "a file collection has no per-entry route to derive — compute() must return null, " +
        "not { url: null }, so the banner hides instead of showing an unactionable hint",
    ).toBeNull();
  });

  test("returns null for a section-collection with no per-entry route, title filled in", () => {
    const { LiveURL, window } = loadLiveURL({ title: "HIPAA Compliance Review" });
    window.location.hash = "#/collections/media_items/entries/some-slug";
    expect(
      LiveURL.compute(),
      "a folder collection outside {posts,tags,projects,pages} has nothing to derive " +
        "regardless of field content — must be null, not a hint the owner can't act on",
    ).toBeNull();
  });

  test("returns null with NO fields at all (still a non-routable collection)", () => {
    const { LiveURL, window } = loadLiveURL({});
    window.location.hash = "#/collections/settings/entries/settings";
    expect(LiveURL.compute()).toBeNull();
  });

  test("still derives a real URL for posts (routable, unaffected by the fix)", () => {
    const { LiveURL, window } = loadLiveURL({ title: "Hello World" });
    window.location.hash = "#/collections/posts/entries/hello-world";
    const data = LiveURL.compute();
    expect(data, "posts is routable — compute() must still return an object").not.toBeNull();
    expect(data.url).toBe("https://example.com/blog/hello-world/");
  });

  test("still derives a real URL for tags (routable, unaffected by the fix)", () => {
    const { LiveURL, window } = loadLiveURL({ name: "policy" });
    window.location.hash = "#/collections/tags/entries/policy";
    const data = LiveURL.compute();
    expect(data).not.toBeNull();
    expect(data.url).toBe("https://example.com/tags/policy/");
  });

  test("still derives a real URL for projects (routable, unaffected by the fix)", () => {
    const { LiveURL, window } = loadLiveURL({ title: "Widget Builder" });
    window.location.hash = "#/collections/projects/entries/widget-builder";
    const data = LiveURL.compute();
    expect(data).not.toBeNull();
    expect(data.url).toBe("https://example.com/projects/widget-builder/");
  });

  test("derives /tools/<slug>/ for tools from the slug field (site-owned collection)", () => {
    const { LiveURL, window } = loadLiveURL({ title: "Some Other Title", slug: "word-counter" });
    window.location.hash = "#/collections/tools/entries/word-counter";
    const data = LiveURL.compute();
    expect(data, "tools has a preview_path route — compute() must return an object").not.toBeNull();
    expect(data.url).toBe("https://example.com/tools/word-counter/");
  });

  test("tools falls back to the slugified title when the slug field is empty", () => {
    const { LiveURL, window } = loadLiveURL({ title: "Word Counter" });
    window.location.hash = "#/collections/tools/entries/word-counter";
    expect(LiveURL.compute().url).toBe("https://example.com/tools/word-counter/");
  });

  test("still derives a real URL for pages via the permalink field (routable, unaffected by the fix)", () => {
    const { LiveURL, window } = loadLiveURL({ permalink: "/about/" });
    window.location.hash = "#/collections/pages/entries/about";
    const data = LiveURL.compute();
    expect(data).not.toBeNull();
    expect(data.url).toBe("https://example.com/about/");
  });

  test("still returns null with no hash route at all (pre-existing behavior, unaffected)", () => {
    const { LiveURL, window } = loadLiveURL({ title: "x" });
    window.location.hash = "";
    expect(LiveURL.compute()).toBeNull();
  });
});

// A typed URL Slug is not served verbatim: Jekyll's `:slug` placeholder
// (Drops::UrlDrop#slug) runs it through Utils.slugify, so `Bad Slug!` is
// served at /blog/bad-slug/. The banner must link what Jekyll serves. The
// expected values are the real-Jekyll golden file, not hand-written.
const SLUG_GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "jekyll-slugify-golden.json"), "utf8"));

test.describe("live-url-derive.js compute() — a typed slug is slugified the way Jekyll serves it", () => {
  test("Bad Slug! links /blog/bad-slug/, not the raw slug", () => {
    const { LiveURL, window } = loadLiveURL({ title: "Some Title", slug: "Bad Slug!" });
    window.location.hash = "#/collections/posts/entries/new";
    expect(LiveURL.compute().url).toBe("https://example.com/blog/bad-slug/");
  });

  test("every non-empty golden case, typed as the slug, links Jekyll's slug (posts and projects)", () => {
    const checked = [];
    for (const [input, expected] of SLUG_GOLDEN.cases) {
      if (!expected) continue; // a slug with no letters or digits: Jekyll serves /blog//, nothing to link
      for (const [collection, route] of [["posts", "/blog/"], ["projects", "/projects/"]]) {
        const { LiveURL, window } = loadLiveURL({ title: "Ignored Title", slug: input });
        window.location.hash = `#/collections/${collection}/entries/new`;
        expect(
          LiveURL.compute().url,
          `${collection} slug ${JSON.stringify(input)}`,
        ).toBe(`https://example.com${route}${expected}/`);
        checked.push(input);
      }
    }
    expect(checked.length, "the golden corpus must exercise the typed-slug path").toBeGreaterThan(40);
  });

  test("an already-pinned slug (slug-pin.js's output, Unicode kept) is unchanged", () => {
    const { LiveURL, window } = loadLiveURL({ title: "Café Notes", slug: "café-notes" });
    window.location.hash = "#/collections/posts/entries/cafe-notes";
    expect(LiveURL.compute().url).toBe("https://example.com/blog/café-notes/");
  });

  test("an empty or whitespace-only slug still derives from the title", () => {
    for (const slug of ["", "   "]) {
      const { LiveURL, window } = loadLiveURL({ title: "Hello World", slug });
      window.location.hash = "#/collections/posts/entries/new";
      expect(LiveURL.compute().url, `slug ${JSON.stringify(slug)}`).toBe("https://example.com/blog/hello-world/");
    }
  });
});

for (const [access, siteURL] of [
  ["https://example.com", "https://example.com"],
  ["https://www.example.com", "https://example.com"],
  ["https://d1234abcd.example.net", "https://example.com"],
  ["https://preview-pr7.example.com", "https://example.com"],
  ["https://example.com", "https://preview-pr7.example.com"],
  ["https://preview-pr7.example.com", "https://preview-pr7.example.com"],
  ["http://localhost:4000", "https://example.com"],
  ["http://localhost:4000", "http://localhost:4000"],
]) {
  test(`LiveURL publication origin: ${access} -> ${siteURL}`, async () => {
    const { LiveURL, window } = loadLiveURL({ title: "Hello", permalink: "/about/" }, { access, siteURL });
    window.location.hash = "#/collections/posts/entries/hello";
    expect(LiveURL.compute().url).toBe(access + "/blog/hello/");
    await window.CMSHostname.binding();
    for (const [collection, route] of [["posts", "/blog/hello/"], ["tags", "/tags/hello/"], ["projects", "/projects/hello/"], ["tools", "/tools/hello/"], ["pages", "/about/"]]) {
      window.location.hash = `#/collections/${collection}/entries/hello`;
      expect(LiveURL.compute().url).toBe(siteURL + route);
    }
  });
}

test("LiveURL preserves publicOrigin when a cached hostname helper lacks destinationOrigin", () => {
  const { LiveURL, window } = loadLiveURL({ title: "Hello" }, { access: "https://admin.example.com" });
  window.CMSHostname = { publicOrigin: () => "https://example.com" };
  window.location.hash = "#/collections/posts/entries/hello";
  expect(LiveURL.compute().url).toBe("https://example.com/blog/hello/");
});

for (const [access, destinationOrigin] of [
  ["https://example.com", "https://example.com"],
  ["https://www.example.com", "https://example.com"],
  ["https://d1234abcd.example.net", "https://example.com"],
  ["https://preview-pr7.example.com", "https://example.com"],
  ["https://example.com", "https://preview-pr7.example.com"],
  ["https://preview-pr7.example.com", "https://preview-pr7.example.com"],
  ["http://localhost:4000", "https://example.com"],
  ["http://localhost:4000", "http://localhost:4000"],
]) {
  test(`Live Preview stays same-origin for BroadcastChannel: ${access} -> ${destinationOrigin}`, () => {
    const sandbox = {
      window: { location: new URL(access + "/admin/"), CMSHostname: { destinationOrigin: () => destinationOrigin } },
      document: { readyState: "loading", addEventListener() {} },
      BroadcastChannel: class {},
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, "theme/admin/preview-bridge.js"), "utf8"), sandbox);
    expect(sandbox.window.adamdaniel_cms_preview_url("posts")).toBe(access + "/preview/?collection=posts");
  });
}
