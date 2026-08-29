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
function loadLiveURL(fields) {
  const src = fs.readFileSync(LIVE_URL_DERIVE_PATH, "utf8");
  const els = {};
  for (const [name, value] of Object.entries(fields || {})) {
    els[name] = { value };
  }
  const sandbox = {
    window: { location: { hash: "", origin: "https://example.com" } },
    document: {
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
