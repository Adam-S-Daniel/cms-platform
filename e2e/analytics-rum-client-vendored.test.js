// @lane: local — pure-fs: hashes the gem-shipped CloudWatch RUM client and RUNS
// the RUM include's loader in a node:vm sandbox; no Jekyll, no browser, no
// network.
//
// Why vendored (#517): every public page runs this client on the origin where
// /admin keeps the editor's GitHub token in localStorage. AWS serves it from a
// floating `1.x` path that cannot carry `integrity`, and SRI against the AWS
// CDN is not an option either: it does not vary its cache on `Origin`, so
// `Access-Control-Allow-Origin` comes back only when the request that filled
// that POP's cache happened to send one, and a `crossorigin` tag is blocked.
// So the gem ships the exact release and the include loads it from the site's
// own origin.
//
// What fails here: an edit to the vendored bytes that provenance.json does not
// record (the hash), a version bump that leaves the file name or the include
// behind, an include that loads the client from anywhere but that file, and a
// loader that runs in an automated browser or on an opted-out device.
//
// The Liquid around the loader (production only, only with an app monitor,
// the values printed into it) is rendered through real Liquid by
// theme/spec/cloudwatch_rum_include_render_test.rb; this file substitutes
// those values from a fixed table and does not evaluate the `if`.
const { test, expect } = require("./base");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const THEME = path.resolve(__dirname, "..", "theme");
const VENDOR_DIR = path.join(THEME, "assets", "js", "aws-rum-web");
const INCLUDE = path.join(THEME, "_includes", "analytics", "cloudwatch-rum.html");
const PROVENANCE = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, "provenance.json"), "utf8"));
// The URL path Jekyll serves the gem's assets/ file at.
const ASSET_PATH = `/assets/js/aws-rum-web/${PROVENANCE.file}`;

const APP_MONITOR = "11111111-2222-3333-4444-555555555555";
const POOL = "us-west-2:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REGION = "us-west-2";

// The include's <script> body with each Liquid output tag replaced by what
// Jekyll would print for a production site with an empty baseurl. A tag not
// in this table fails the test, so a new value cannot slip into the loader
// unexamined.
function renderedLoader() {
  const src = fs.readFileSync(INCLUDE, "utf8");
  const open = src.indexOf("<script>");
  const close = src.indexOf("</script>");
  expect(open, "the include carries one inline <script>").toBeGreaterThanOrEqual(0);
  expect(src.indexOf("<script", open + 1), "and only one").toBe(-1);
  const body = src.slice(open + "<script>".length, close);
  const values = {
    "_rum.app_monitor_id": APP_MONITOR,
    "_rum.identity_pool_id": POOL,
    _region: REGION,
    [`'${ASSET_PATH}' | relative_url`]: ASSET_PATH,
  };
  let out = "";
  let at = 0;
  for (;;) {
    const start = body.indexOf("{{", at);
    if (start < 0) break;
    const end = body.indexOf("}}", start);
    const expr = body.slice(start + 2, end).trim();
    expect(Object.keys(values), `unexpected Liquid output tag {{ ${expr} }}`).toContain(expr);
    out += body.slice(at, start) + values[expr];
    at = end + 2;
  }
  return out + body.slice(at);
}

// Run the loader against a hand-built browser and return what it did.
function boot({ search = "", webdriver = false, stored = {} } = {}) {
  const inserted = [];
  const head = {
    getElementsByTagName: () => [],
    insertBefore(el, ref) {
      inserted.push({ el, ref });
    },
  };
  const storage = new Map(Object.entries(stored));
  const win = {
    location: { search },
    navigator: { webdriver },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    URLSearchParams,
    document: {
      head,
      createElement: (tag) => ({ tagName: tag.toUpperCase() }),
    },
  };
  win.window = win;
  vm.runInNewContext(renderedLoader(), win);
  return { win, inserted, storage };
}

function sha384(file) {
  return crypto.createHash("sha384").update(fs.readFileSync(file)).digest("base64");
}

test.describe("CloudWatch RUM client is the gem-shipped, hash-locked release", () => {
  test("the vendored bytes are exactly the release provenance.json records", () => {
    expect(PROVENANCE.file).toBe(`cwr-${PROVENANCE.version}.js`);
    expect(PROVENANCE.source).toBe(
      `https://client.rum.us-east-1.amazonaws.com/${PROVENANCE.version}/cwr.js`,
    );
    expect(sha384(path.join(VENDOR_DIR, PROVENANCE.file))).toBe(PROVENANCE.sha384);
  });

  test("the Apache-2.0 license and notice ship beside it", () => {
    for (const name of ["LICENSE", "NOTICE", "LICENSE-THIRD-PARTY"]) {
      expect(fs.existsSync(path.join(VENDOR_DIR, name)), name).toBe(true);
    }
    // The bundle's own header points at these files by name.
    const head = fs.readFileSync(path.join(VENDOR_DIR, PROVENANCE.file), "utf8").slice(0, 200);
    expect(head).toContain("LICENSE and LICENSE-THIRD-PARTY");
    // No front matter, so Jekyll copies it as a static file, byte for byte.
    expect(head.startsWith("---")).toBe(false);
  });

  test("only the current release is vendored", () => {
    const clients = fs.readdirSync(VENDOR_DIR).filter((n) => /^cwr-.*\.js$/.test(n));
    expect(clients).toEqual([PROVENANCE.file]);
  });

  test("the loader creates one async script whose src is the same-origin copy", () => {
    const { win, inserted } = boot();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].el).toEqual({ tagName: "SCRIPT", async: true, src: ASSET_PATH });
    // The queue the real client drains once it loads.
    expect(win.AwsRumClient.n).toBe("cwr");
    expect(typeof win.cwr).toBe("function");
  });

  test("the region configures the data plane, not where the client loads from", () => {
    const { win } = boot();
    expect(win.AwsRumClient.r).toBe(REGION);
    expect(win.AwsRumClient.c.endpoint).toBe(`https://dataplane.rum.${REGION}.amazonaws.com`);
    expect(win.AwsRumClient.c.identityPoolId).toBe(POOL);
    expect(fs.readFileSync(INCLUDE, "utf8")).not.toContain("client.rum.");
  });

  test("an automated browser (navigator.webdriver) loads no client", () => {
    // Keeps CI's Playwright traffic out of real-user metrics.
    const { win, inserted } = boot({ webdriver: true });
    expect(inserted).toHaveLength(0);
    expect(win.AwsRumClient).toBeUndefined();
  });

  test("?rum=off opts the device out until ?rum=on", () => {
    const off = boot({ search: "?rum=off" });
    expect(off.inserted).toHaveLength(0);
    expect(off.storage.get("rum-opt-out")).toBe("1");

    const later = boot({ stored: { "rum-opt-out": "1" } });
    expect(later.inserted).toHaveLength(0);

    const on = boot({ search: "?rum=on", stored: { "rum-opt-out": "1" } });
    expect(on.inserted).toHaveLength(1);
    expect(on.storage.has("rum-opt-out")).toBe(false);
  });
});
