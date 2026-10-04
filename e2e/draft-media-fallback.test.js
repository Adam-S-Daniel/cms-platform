// @lane: local — pure-Node sandbox unit tests for the draft media fallback shim
/*
 * Unit tests for theme/admin/draft-media-fallback.js, which retries a broken
 * editor or Live Preview image from the upload this tab holds, or from the
 * entry's cms/ branch (the file's header has the defect: Decap's absolute
 * public_folder makes a just-uploaded image 404 on the admin's own origin).
 *
 * Three parts:
 *   - the pure helpers (config read, path match, Decap's upload-name
 *     transform, branch derivation, Contents API URL), loaded in a vm sandbox
 *     with no `document`, so only `window.CMSDraftMedia` is set up;
 *   - the runtime, in a sandbox with a fake document, File, URL and fetch:
 *     an <img> error is captured and answered once, from the File first and
 *     the branch second, and never twice for one src;
 *   - where it loads: non-deferred and before decap-cms.js in the production
 *     and local shells (it must wrap URL.createObjectURL before Decap uses
 *     it), and from the Live Preview layout. Lexical scan of literal <script>
 *     tags, the admin-shim-load-order.test.js precedent.
 *
 * No network, no clock: fetch is a stub and promise chains are flushed with
 * setImmediate.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "draft-media-fallback.js"), "utf8");
const ORIGIN = "https://site.example.com";

function loadHelpers() {
  const sandbox = { window: {}, URL };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.window.CMSDraftMedia;
  expect(api && typeof api.normalizeUploadName, "must expose window.CMSDraftMedia").toBe("function");
  return api;
}

const CONFIG = [
  "backend:",
  "  name: github",
  "  repo: owner/site # the site repo",
  "  branch: main",
  "publish_mode: editorial_workflow",
  'media_folder: "assets/images/uploads"',
  "public_folder: /assets/images/uploads",
  "collections:",
  "  - name: posts",
  "    media_folder: elsewhere",
].join("\n");

test.describe("draft-media-fallback.js helpers", () => {
  test("parseConfig reads the top-level media and backend leaves only", () => {
    const api = loadHelpers();
    const cfg = api.parseConfig(CONFIG);
    expect(cfg.publicFolder).toBe("/assets/images/uploads");
    expect(cfg.mediaFolder).toBe("assets/images/uploads");
    expect(cfg.backendName).toBe("github");
    expect(cfg.repo).toBe("owner/site");
    expect(cfg.branch).toBe("main");
    expect(cfg.localBackend).toBe(false);
    expect({ ...cfg.slug }).toEqual({});

    const local = api.parseConfig("local_backend: true\nslug:\n  encoding: ascii\n  clean_accents: true\n  sanitize_replacement: '_'\n");
    expect(local.localBackend).toBe(true);
    expect({ ...local.slug }).toEqual({ encoding: "ascii", clean_accents: true, sanitize_replacement: "_" });
  });

  test("parseConfig reads the platform's own base config", () => {
    const api = loadHelpers();
    const cfg = api.parseConfig(fs.readFileSync(path.join(ADMIN, "config.base.yml"), "utf8"));
    expect(cfg.publicFolder).toBe("/assets/images/uploads");
    expect(cfg.mediaFolder).toBe("assets/images/uploads");
    expect(cfg.backendName).toBe("github");
    expect(cfg.branch).toBe("main");
  });

  test("uploadBasename matches same-origin paths directly under public_folder", () => {
    const api = loadHelpers();
    const pf = "/assets/images/uploads";
    expect(api.uploadBasename(`${ORIGIN}/assets/images/uploads/r.jpeg`, ORIGIN, pf)).toBe("r.jpeg");
    expect(api.uploadBasename("/assets/images/uploads/a%20b.png", ORIGIN, pf)).toBe("a b.png");
    expect(api.uploadBasename(`${ORIGIN}/assets/images/uploads/r.jpeg?x=1`, ORIGIN, pf)).toBe("r.jpeg");
    expect(api.uploadBasename("https://cdn.example.net/assets/images/uploads/r.jpeg", ORIGIN, pf)).toBeNull();
    expect(api.uploadBasename(`${ORIGIN}/assets/images/uploadsx/r.jpeg`, ORIGIN, pf)).toBeNull();
    expect(api.uploadBasename(`${ORIGIN}/assets/images/uploads/`, ORIGIN, pf)).toBeNull();
    expect(api.uploadBasename(`${ORIGIN}/assets/images/uploads/a/b.png`, ORIGIN, pf)).toBeNull();
    expect(api.uploadBasename(`${ORIGIN}/assets/images/uploads/r.jpeg`, ORIGIN, null)).toBeNull();
    expect(api.uploadBasename("blob:" + ORIGIN + "/uuid", ORIGIN, pf)).toBeNull();
  });

  test("normalizeUploadName mirrors Decap's sanitizeSlug(name.toLowerCase(), slug)", () => {
    const api = loadHelpers();
    const n = (name, opts) => api.normalizeUploadName(name, opts);
    expect(n("IMG_1309.JPEG")).toBe("img_1309.jpeg");
    expect(n("My Photo (1).JPG")).toBe("my-photo-1-.jpg");
    expect(n("a?b*c.png")).toBe("a-b-c.png");
    expect(n("  spaced  .png")).toBe("spaced-.png");
    expect(n("trailing.")).toBe("trailing");
    expect(n("Café.PNG")).toBe("café.png");
    expect(n("Café.PNG", { encoding: "ascii" })).toBe("caf-.png");
    expect(n("Café.PNG", { encoding: "ascii", clean_accents: true })).toBe("cafe.png");
    expect(n("a b.png", { sanitize_replacement: "_" })).toBe("a_b.png");
    expect(n("a b.png", { sanitize_replacement: "" })).toBe("ab.png");
  });

  test("entryFromHash and editorialBranch follow Decap's cms/<collection>/<slug>", () => {
    const api = loadHelpers();
    const e = api.entryFromHash("#/collections/posts/entries/2026-10-04-hello");
    expect({ ...e }).toEqual({ collection: "posts", slug: "2026-10-04-hello" });
    expect(api.editorialBranch(e)).toBe("cms/posts/2026-10-04-hello");
    expect(api.editorialBranch(api.entryFromHash("#/collections/docs/entries/a/b?x=1"))).toBe("cms/docs/a/b");
    expect(api.entryFromHash("#/collections/posts/new")).toBeNull();
    expect(api.entryFromHash("#/collections/posts")).toBeNull();
    expect(api.entryFromHash("#/collections/posts/entries/../x")).toBeNull();
    expect(api.editorialBranch({ collection: "posts", slug: "" })).toBeNull();
    expect(api.editorialBranch(null)).toBeNull();
  });

  test("imageType names the media type a fetched upload is retyped to", () => {
    const api = loadHelpers();
    expect(api.imageType("a.SVG")).toBe("image/svg+xml");
    expect(api.imageType("a.jpeg")).toBe("image/jpeg");
    expect(api.imageType("a.png")).toBe("image/png");
    expect(api.imageType("noext")).toBe("");
  });

  test("contentsURL encodes segments and refuses a malformed repo or path", () => {
    const api = loadHelpers();
    expect(api.contentsURL("owner/site", "assets/images/uploads", "a b.png", "cms/posts/x")).toBe(
      "https://api.github.com/repos/owner/site/contents/assets/images/uploads/a%20b.png?ref=cms%2Fposts%2Fx",
    );
    expect(api.contentsURL("/assets/x", "assets", "a.png", "main")).toBeNull();
    expect(api.contentsURL("owner/site/extra", "assets", "a.png", "main")).toBeNull();
    expect(api.contentsURL("{{CMS_REPO}}", "assets", "a.png", "main")).toBeNull();
    expect(api.contentsURL("owner/site", "assets/../secret", "a.png", "main")).toBeNull();
    expect(api.contentsURL("owner/site", "assets", "..", "main")).toBeNull();
    expect(api.contentsURL("owner/site", "assets", "a.png", "")).toBeNull();
  });
});

// ── Runtime ────────────────────────────────────────────────────────────

class FakeFile {
  constructor(name) {
    this.name = name;
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await flush();
}

function bootRuntime({ hash = "", token = "t0k3n", branchFiles = {}, config = CONFIG } = {}) {
  const listeners = {};
  const fetches = [];
  let blobs = 0;
  const fakeURL = function (u, base) {
    return new URL(u, base);
  };
  fakeURL.createObjectURL = (obj) => `blob:${ORIGIN}/${obj && obj.name ? obj.name : "data"}-${(blobs += 1)}`;
  const document = {
    readyState: "complete",
    baseURI: `${ORIGIN}/admin/`,
    currentScript: { src: `${ORIGIN}/admin/draft-media-fallback.js` },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn, capture) {
      (listeners[`${type}:${capture ? "capture" : "bubble"}`] ||= []).push(fn);
    },
  };
  const window = {
    location: { origin: ORIGIN, href: `${ORIGIN}/admin/`, hash },
    localStorage: { getItem: (k) => (k === "decap-cms-user" && token ? JSON.stringify({ token }) : null) },
  };
  window.URL = fakeURL;
  const sandbox = {
    window,
    document,
    URL: fakeURL,
    File: FakeFile,
    WeakMap,
    Blob: class {
      constructor(parts, opts) {
        this.name = parts[0] && parts[0].name;
        this.type = opts && opts.type;
      }
    },
    console: { debug() {} },
    fetch(url, init) {
      fetches.push({ url: String(url), init: init || {} });
      if (String(url) === `${ORIGIN}/admin/config.yml`) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(config) });
      }
      const body = branchFiles[String(url)];
      if (body) return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ name: body }) });
      return Promise.resolve({ ok: false, status: 404 });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  function img(src) {
    const attrs = {};
    return {
      tagName: "IMG",
      src,
      currentSrc: src,
      complete: true,
      naturalWidth: 0,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      setAttribute: (k, v) => {
        attrs[k] = String(v);
      },
      removeAttribute: (k) => {
        delete attrs[k];
      },
    };
  }
  function fireError(target) {
    for (const fn of listeners["error:capture"] || []) fn({ target });
  }
  return { window, listeners, fetches, img, fireError, api: window.CMSDraftMedia };
}

test.describe("draft-media-fallback.js runtime", () => {
  test("listens for image errors and iframe loads in the capture phase", () => {
    const rt = bootRuntime();
    expect((rt.listeners["error:capture"] || []).length).toBe(1);
    expect((rt.listeners["load:capture"] || []).length).toBe(1);
    expect(rt.listeners["error:bubble"]).toBeUndefined();
  });

  test("an upload this tab made is shown from its File, without a GitHub read", async () => {
    const rt = bootRuntime({ hash: "#/collections/posts/new" });
    rt.window.URL.createObjectURL(new FakeFile("IMG_1309.JPEG")); // what Decap's AssetProxy does
    const el = rt.img(`${ORIGIN}/assets/images/uploads/img_1309.jpeg`);
    rt.fireError(el);
    await settle();
    expect(el.src).toMatch(/^blob:.*IMG_1309\.JPEG-/);
    expect(rt.fetches.filter((f) => f.url.startsWith("https://api.github.com"))).toEqual([]);
  });

  test("otherwise reads the entry's cms/ branch, then the config branch", async () => {
    const onMain = "https://api.github.com/repos/owner/site/contents/assets/images/uploads/r.jpeg?ref=main";
    const rt = bootRuntime({ hash: "#/collections/posts/entries/hello", branchFiles: { [onMain]: "main-bytes" } });
    const el = rt.img(`${ORIGIN}/assets/images/uploads/r.jpeg`);
    rt.fireError(el);
    await settle();
    const gh = rt.fetches.filter((f) => f.url.startsWith("https://api.github.com"));
    expect(gh.map((f) => f.url)).toEqual([
      "https://api.github.com/repos/owner/site/contents/assets/images/uploads/r.jpeg?ref=cms%2Fposts%2Fhello",
      onMain,
    ]);
    expect(gh[0].init.headers.Authorization).toBe("token t0k3n");
    expect(gh[0].init.headers.Accept).toBe("application/vnd.github.raw");
    expect(gh[0].init.cache).toBe("no-cache");
    expect(el.src).toMatch(/^blob:.*main-bytes-/);
  });

  test("retries one src once, and ignores other images", async () => {
    const rt = bootRuntime({ hash: "#/collections/posts/entries/hello" });
    const el = rt.img(`${ORIGIN}/assets/images/uploads/missing.jpeg`);
    rt.fireError(el);
    await settle();
    rt.fireError(el);
    await settle();
    const reads = () => rt.fetches.filter((f) => f.url.startsWith("https://api.github.com")).length;
    expect(reads()).toBe(2); // the cms/ branch and main, once
    expect(el.src).toBe(`${ORIGIN}/assets/images/uploads/missing.jpeg`);

    rt.fireError(rt.img(`${ORIGIN}/assets/css/site.png`));
    rt.fireError(rt.img("https://cdn.example.net/assets/images/uploads/x.png"));
    rt.fireError({ tagName: "SCRIPT" });
    await settle();
    expect(reads()).toBe(2);

    // retry() grants exactly one more attempt to a still-broken image.
    rt.api.setEntry({ collection: "posts", slug: "other" });
    rt.api.retry({ querySelectorAll: () => [el] });
    await settle();
    expect(reads()).toBe(4);
    expect(rt.fetches.some((f) => f.url.endsWith("?ref=cms%2Fposts%2Fother"))).toBe(true);
  });

  test("stays off GitHub without a token, or on a local_backend config", async () => {
    const noToken = bootRuntime({ hash: "#/collections/posts/entries/hello", token: null });
    noToken.fireError(noToken.img(`${ORIGIN}/assets/images/uploads/r.jpeg`));
    await settle();
    expect(noToken.fetches.filter((f) => f.url.startsWith("https://api.github.com"))).toEqual([]);

    const local = bootRuntime({ hash: "#/collections/posts/entries/hello", config: `local_backend: true\n${CONFIG}` });
    local.fireError(local.img(`${ORIGIN}/assets/images/uploads/r.jpeg`));
    await settle();
    expect(local.fetches.filter((f) => f.url.startsWith("https://api.github.com"))).toEqual([]);
  });
});

// ── Where it loads ─────────────────────────────────────────────────────

function scriptTag(html, src) {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<script\\s+src="${escaped}"([^>]*)>\\s*</script>`).exec(html);
  return m ? { index: m.index, defer: /\bdefer\b/.test(m[1]) } : null;
}

test.describe("draft-media-fallback.js load order", () => {
  for (const shell of ["index.html", "index-local.html"]) {
    test(`theme/admin/${shell} loads it non-deferred, before decap-cms.js`, () => {
      const html = fs.readFileSync(path.join(ADMIN, shell), "utf8");
      const decap = /<script\s+src="https:\/\/unpkg\.com\/decap-cms@[^"']+"[^>]*>/.exec(html);
      expect(decap, `${shell} loads the decap-cms bundle`).not.toBeNull();
      const tag = scriptTag(html, "draft-media-fallback.js");
      expect(tag, `${shell} must load draft-media-fallback.js`).not.toBeNull();
      expect(tag.defer, "it wraps URL.createObjectURL, so it must not be deferred").toBe(false);
      expect(tag.index).toBeLessThan(decap.index);
    });
  }

  test("theme/_layouts/preview.html loads it before its own render script", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../theme/_layouts/preview.html"), "utf8");
    const tag = scriptTag(html, '{{ "/admin/draft-media-fallback.js" | relative_url }}');
    expect(tag, "preview.html must load /admin/draft-media-fallback.js").not.toBeNull();
    expect(tag.defer).toBe(false);
    expect(tag.index).toBeLessThan(html.indexOf("function update(data)"));
  });
});
