// @lane: local — pure-Node sandbox unit tests for the media library tidy shim
/*
 * Unit tests for theme/admin/media-library-tidy.js (#736), which fixes two
 * Decap media-library rough edges that have no config lever:
 *
 *   1. `Workshop Diagram (final).jpg` was stored as
 *      `workshop-diagram-final-.jpg`. Decap's persistMedia names the file
 *      sanitizeSlug(file.name.toLowerCase(), config.slug), and sanitizeSlug
 *      trims a trailing replacement off the WHOLE string, which still ends in
 *      ".jpg". The shim trims the base name before Decap reads it. The Decap
 *      side is pinned through draft-media-fallback.js's normalizeUploadName,
 *      its mirror of that transform, so the test shows the defect AND the fix.
 *   2. `.gitkeep` is listed as a tile. The shim drops dotfiles from the
 *      listing responses (GitHub tree, decap-server getMedia) in a fetch wrap.
 *
 * Three parts: the pure helpers, the runtime (fake document, real File,
 * Response and Request), and where the shells load it. No network, no clock.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "media-library-tidy.js"), "utf8");
const FALLBACK_SRC = fs.readFileSync(path.join(ADMIN, "draft-media-fallback.js"), "utf8");

// A sandbox with the browser pieces the shim touches. `fetchImpl` is the
// "network" the wrapped window.fetch falls through to.
function load({ fetchImpl } = {}) {
  const listeners = {};
  const sandbox = {
    window: {},
    document: {
      addEventListener(type, fn, capture) {
        (listeners[type] = listeners[type] || []).push({ fn, capture });
      },
    },
    URL,
    Headers,
    Response,
    JSON,
    Object,
    Array,
  };
  if (fetchImpl) sandbox.window.fetch = fetchImpl;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { win: sandbox.window, api: sandbox.window.CMSMediaTidy, listeners };
}

function decapName(name) {
  const sandbox = { window: {}, URL };
  vm.createContext(sandbox);
  vm.runInContext(FALLBACK_SRC, sandbox);
  return sandbox.window.CMSDraftMedia.normalizeUploadName(name, {});
}

test.describe("tidyUploadName", () => {
  const { api } = load();

  const cases = [
    ["Workshop Diagram (final).jpg", "Workshop Diagram (final.jpg"],
    ["photo (1).png", "photo (1.png"],
    ["my-photo-.jpg", "my-photo.jpg"],
    ["__cover__.webp", "cover.webp"],
    ["Plain Name.jpg", "Plain Name.jpg"],
    ["already-clean.png", "already-clean.png"],
    ["archive.tar.gz", "archive.tar.gz"],
    ["(draft) hero.jpg", "draft) hero.jpg"],
    ["Café (menu).JPG", "Café (menu.JPG"],
    ["日本語 (写真).jpg", "日本語 (写真.jpg"],
    ["noextension (x)", "noextension (x"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(api.tidyUploadName(input)).toBe(expected);
    });
  }

  test("a name with nothing to keep, a dotfile and a non-string pass through", () => {
    expect(api.tidyUploadName("().")).toBe("().");
    expect(api.tidyUploadName("---.png")).toBe("---.png");
    expect(api.tidyUploadName(".gitkeep")).toBe(".gitkeep");
    expect(api.tidyUploadName(undefined)).toBeUndefined();
  });

  test("Decap stores the tidied name without the trailing hyphen", () => {
    // The defect, through Decap's own transform: the ")" before the dot.
    expect(decapName("Workshop Diagram (final).jpg")).toBe("workshop-diagram-final-.jpg");
    // The fix.
    for (const name of [
      "Workshop Diagram (final).jpg",
      "my-photo-.jpg",
      "Report [v2].PNG",
      "Q&A (notes)!.jpeg",
    ]) {
      const stored = decapName(api.tidyUploadName(name));
      expect(stored, name).toMatch(/[a-z0-9]\.[a-z]+$/);
      expect(stored, name).not.toMatch(/-\.[a-z]+$/);
    }
    expect(decapName(api.tidyUploadName("Workshop Diagram (final).jpg"))).toBe(
      "workshop-diagram-final.jpg",
    );
  });

  test("a name Decap already stores cleanly is stored the same", () => {
    for (const name of ["Plain Name.jpg", "already-clean.png", "photo (1) copy.jpg"]) {
      expect(decapName(api.tidyUploadName(name)), name).toBe(decapName(name));
    }
  });
});

test.describe("listing filters", () => {
  const { api } = load();

  test("isHiddenMediaName hides dotfiles only", () => {
    expect(api.isHiddenMediaName(".gitkeep")).toBe(true);
    expect(api.isHiddenMediaName(".DS_Store")).toBe(true);
    expect(api.isHiddenMediaName("photo.jpg")).toBe(false);
    expect(api.isHiddenMediaName("a.b.jpg")).toBe(false);
    expect(api.isHiddenMediaName(undefined)).toBe(false);
  });

  test("filterTree drops dotfile blobs and keeps everything else", () => {
    const tree = {
      sha: "abc",
      truncated: false,
      tree: [
        { path: ".gitkeep", type: "blob", sha: "1" },
        { path: "hero.jpg", type: "blob", sha: "2" },
        { path: ".hidden-dir", type: "tree", sha: "3" },
        { path: "sub/.gitkeep", type: "blob", sha: "4" },
        { path: "sub/pic.png", type: "blob", sha: "5" },
      ],
    };
    const out = api.filterTree(tree);
    expect(out.tree.map((e) => e.path)).toEqual(["hero.jpg", ".hidden-dir", "sub/pic.png"]);
    expect(out.sha).toBe("abc");
    expect(tree.tree).toHaveLength(5);
    expect(api.filterTree({ message: "Not Found" })).toEqual({ message: "Not Found" });
    expect(api.filterTree(null)).toBeNull();
  });

  test("filterLocalMedia drops dotfiles, by name or by path", () => {
    const out = api.filterLocalMedia([
      { name: ".gitkeep", path: "assets/images/uploads/.gitkeep" },
      { name: "hero.jpg", path: "assets/images/uploads/hero.jpg" },
      { path: "assets/images/uploads/.DS_Store" },
    ]);
    expect(out.map((f) => f.path)).toEqual(["assets/images/uploads/hero.jpg"]);
    expect(api.filterLocalMedia({ error: "x" })).toEqual({ error: "x" });
  });

  test("isTreeListingURL matches a directory listing only", () => {
    const base = "https://api.github.com/repos/o/r/git/trees";
    expect(api.isTreeListingURL(`${base}/main:assets/images/uploads`, "GET")).toBe(true);
    expect(api.isTreeListingURL(`${base}/cms/posts/x:assets%2Fimages%2Fuploads`, "GET")).toBe(true);
    expect(api.isTreeListingURL(`${base}/0123abcd`, "GET")).toBe(false);
    expect(api.isTreeListingURL(`${base}/main:assets`, "POST")).toBe(false);
    expect(api.isTreeListingURL("https://api.github.com/repos/o/r/contents/x", "GET")).toBe(false);
    expect(api.isTreeListingURL("not a url at all", "GET")).toBe(false);
  });

  test("isLocalGetMedia matches a decap-server getMedia body only", () => {
    expect(api.isLocalGetMedia("POST", JSON.stringify({ action: "getMedia", params: {} }))).toBe(true);
    expect(api.isLocalGetMedia("POST", JSON.stringify({ action: "persistMedia" }))).toBe(false);
    expect(api.isLocalGetMedia("POST", "getMedia but not json")).toBe(false);
    expect(api.isLocalGetMedia("GET", JSON.stringify({ action: "getMedia" }))).toBe(false);
    expect(api.isLocalGetMedia("POST", undefined)).toBe(false);
  });
});

test.describe("upload listeners", () => {
  function captureListener(listeners, type) {
    const entries = listeners[type] || [];
    expect(entries, `a ${type} listener`).toHaveLength(1);
    expect(entries[0].capture, `${type} must be a capture-phase listener (before React's root)`).toBe(
      true,
    );
    return entries[0].fn;
  }

  test("a picked file is renamed in place, keeping its identity and bytes", async () => {
    const { listeners } = load();
    const onChange = captureListener(listeners, "change");
    const file = new File(["pixels"], "Workshop Diagram (final).jpg", { type: "image/jpeg" });
    onChange({ target: { type: "file", files: [file] } });
    expect(file.name).toBe("Workshop Diagram (final.jpg");
    expect(file).toBeInstanceOf(File);
    expect(await file.text()).toBe("pixels");
    expect(file.type).toBe("image/jpeg");
  });

  test("a dropped file is renamed the same way", () => {
    const { listeners } = load();
    const onDrop = captureListener(listeners, "drop");
    const file = new File(["x"], "scan (2).png");
    onDrop({ dataTransfer: { files: [file] } });
    expect(file.name).toBe("scan (2.png");
  });

  test("a clean name, a non-file input and a drop without files are left alone", () => {
    const { listeners } = load();
    const onChange = captureListener(listeners, "change");
    const onDrop = captureListener(listeners, "drop");
    const clean = new File(["x"], "clean.png");
    onChange({ target: { type: "file", files: [clean] } });
    expect(clean.name).toBe("clean.png");
    expect(Object.prototype.hasOwnProperty.call(clean, "name")).toBe(false);

    const text = { type: "text", files: [new File(["x"], "odd (a).png")] };
    onChange({ target: text });
    expect(text.files[0].name).toBe("odd (a).png");

    expect(() => onDrop({})).not.toThrow();
    expect(() => onDrop({ dataTransfer: {} })).not.toThrow();
    expect(() => onChange({ target: null })).not.toThrow();
  });

  test("the renamed File is what draft-media-fallback matches to Decap's stored name", () => {
    const { listeners, api } = load();
    const onChange = captureListener(listeners, "change");
    const file = new File(["x"], "Workshop Diagram (final).jpg");
    onChange({ target: { type: "file", files: [file] } });
    expect(decapName(file.name)).toBe("workshop-diagram-final.jpg");
    expect(api.tidyUploadName(file.name)).toBe(file.name);
  });

  test("it installs once", () => {
    const sandbox = {
      window: {},
      document: {
        addEventListener() {
          sandbox.count += 1;
        },
      },
      count: 0,
      URL,
      Headers,
      Response,
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    const first = sandbox.count;
    vm.runInContext(SRC, sandbox);
    expect(first).toBe(2);
    expect(sandbox.count).toBe(first);
  });
});

test.describe("fetch wrap", () => {
  const TREE = {
    sha: "abc",
    tree: [
      { path: ".gitkeep", type: "blob", sha: "1" },
      { path: "hero.jpg", type: "blob", sha: "2" },
    ],
  };
  const TREE_URL = "https://api.github.com/repos/o/r/git/trees/main:assets/images/uploads";

  function json(body, init) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "content-length": "999" },
      ...init,
    });
  }

  test("a GitHub media-folder listing loses its dotfiles (Request input, as Decap sends it)", async () => {
    const calls = [];
    const { win } = load({
      fetchImpl: async (input, init) => {
        calls.push([input, init]);
        return json(TREE);
      },
    });
    const req = new Request(TREE_URL);
    const res = await win.fetch(req);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(req);
    expect(calls[0][1]).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.tree.map((e) => e.path)).toEqual(["hero.jpg"]);
    expect(body.sha).toBe("abc");
  });

  test("a string URL works too", async () => {
    const { win } = load({ fetchImpl: async () => json(TREE) });
    const body = await (await win.fetch(TREE_URL, { method: "GET" })).json();
    expect(body.tree.map((e) => e.path)).toEqual(["hero.jpg"]);
  });

  test("decap-server's getMedia answer loses its dotfiles", async () => {
    const files = [
      { name: ".gitkeep", path: "assets/images/uploads/.gitkeep" },
      { name: "hero.jpg", path: "assets/images/uploads/hero.jpg" },
    ];
    const { win } = load({ fetchImpl: async () => json(files) });
    const res = await win.fetch("http://localhost:8081/api/v1", {
      method: "POST",
      body: JSON.stringify({ action: "getMedia", params: { mediaFolder: "assets/images/uploads" } }),
    });
    expect((await res.json()).map((f) => f.name)).toEqual(["hero.jpg"]);
  });

  test("every other request passes through untouched, with the caller's own arguments", async () => {
    const seen = [];
    const sentinel = json({ ok: true });
    const { win } = load({
      fetchImpl: async (input, init) => {
        seen.push([input, init]);
        return sentinel;
      },
    });
    const otherPost = { method: "POST", body: JSON.stringify({ action: "persistMedia" }) };
    const cases = [
      ["https://api.github.com/repos/o/r/git/trees/abc123", undefined],
      ["https://api.github.com/repos/o/r/contents/_posts/x.md", { method: "GET" }],
      ["http://localhost:8081/api/v1", otherPost],
      [TREE_URL, { method: "PUT", body: "{}" }],
    ];
    for (const [url, init] of cases) {
      const res = await win.fetch(url, init);
      expect(res, url).toBe(sentinel);
    }
    expect(seen.map(([u]) => u)).toEqual(cases.map(([u]) => u));
    seen.forEach(([, init], i) => expect(init).toBe(cases[i][1]));
  });

  test("a failed or unparseable listing comes back as it was", async () => {
    const notFound = new Response("nope", { status: 404 });
    const { win } = load({ fetchImpl: async () => notFound });
    expect(await win.fetch(TREE_URL)).toBe(notFound);

    const html = new Response("<html>", { status: 200 });
    const { win: win2 } = load({ fetchImpl: async () => html });
    const res = await win2.fetch(TREE_URL);
    expect(await res.text()).toBe("<html>");
  });
});

test.describe("media-library-tidy.js load order", () => {
  function scriptTag(html, src) {
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`<script\\s+src="${escaped}"([^>]*)>\\s*</script>`).exec(html);
    return m ? { index: m.index, defer: /\bdefer\b/.test(m[1]) } : null;
  }

  for (const shell of ["index.html", "index-local.html"]) {
    test(`theme/admin/${shell} loads it non-deferred, before decap-cms.js`, () => {
      const html = fs.readFileSync(path.join(ADMIN, shell), "utf8");
      const decap = /<script\s+src="https:\/\/unpkg\.com\/decap-cms@[^"']+"[^>]*>/.exec(html);
      expect(decap, `${shell} loads the decap-cms bundle`).not.toBeNull();
      const tag = scriptTag(html, "media-library-tidy.js");
      expect(tag, `${shell} must load media-library-tidy.js`).not.toBeNull();
      expect(tag.defer, "it wraps window.fetch, so it must not be deferred").toBe(false);
      expect(tag.index).toBeLessThan(decap.index);
    });
  }

  test("theme/admin/index-test.html (the stock-Decap rehearsal shell) does not load it", () => {
    const html = fs.readFileSync(path.join(ADMIN, "index-test.html"), "utf8");
    expect(scriptTag(html, "media-library-tidy.js")).toBeNull();
  });
});
