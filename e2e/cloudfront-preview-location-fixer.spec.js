// @lane: local — pure-Node parse of the CloudFront FunctionCode YAML; no network
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Pulls the inline FunctionCode of the PreviewLocationFixerFunction out of
// the CloudFormation template and asserts it strips the S3-internal /pr-N/
// prefix from response Location headers, so that S3's trailing-slash
// redirect (e.g. /admin → /pr-23/admin/) doesn't leak to the browser.
//
// Without this fixer, hitting https://preview-prN.example.test/admin
// (no trailing slash) gets a 302 to /pr-N/admin/ which then 404s.
//
// blog-slug-literal-lint: allowed: literal slug used for known fixture —
// the `/blog/foo/` strings are synthetic redirect-fixer inputs.

const TEMPLATE_PATH = path.join(__dirname, "..", "infrastructure/bootstrap/template.yaml");
// Synthetic apex baked into the body in place of the Fn::Sub'd
// ${ProductionDomainName}, so the parameterized host-matching runs as deployed.
const TEST_APEX = "example.test";

function loadHandler(functionName) {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const lines = template.split("\n");

  // Find the function resource declaration and walk forward to the
  // FunctionCode: | block scalar; capture only lines whose indentation
  // exceeds the block's introducer so we stop at the next sibling key.
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s*${functionName}:\\s*$`).test(l));
  if (startIdx < 0) {
    throw new Error(`Could not locate resource ${functionName} in template`);
  }
  const codeIdx = lines.findIndex(
    (l, i) => i > startIdx && /^\s*FunctionCode:\s*(?:!Sub\s+)?\|\s*$/.test(l),
  );
  if (codeIdx < 0) {
    throw new Error(`No FunctionCode block under ${functionName}`);
  }
  // Block scalar lines are more indented than the introducer.
  const introIndent = lines[codeIdx].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = codeIdx + 1; i < lines.length; i++) {
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (lines[i].length === 0) {
      body.push("");
      continue;
    }
    if (indent <= introIndent) break;
    body.push(lines[i]);
  }
  // Dedent by the block's first non-empty line.
  const firstNonEmpty = body.find((l) => l.length > 0) || "";
  const blockIndent = firstNonEmpty.match(/^(\s*)/)[1].length;
  const src = body
    .map((l) => l.slice(blockIndent))
    .join("\n")
    // Simulate Fn::Sub: substitute the injected apex so host-matching runs as deployed.
    .replace(/\$\{ProductionDomainName\}/g, TEST_APEX);

  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn handler;`)();
}

function response(host, status, location) {
  const headers = {};
  if (location !== undefined) headers.location = { value: location };
  return {
    request: {
      headers: host ? { host: { value: host } } : {},
    },
    response: {
      statusCode: status,
      headers,
    },
  };
}

test.describe("CloudFront preview-location-fixer function", () => {
  const handler = loadHandler("PreviewLocationFixerFunction");

  test("strips /pr-23/ from a 302 Location on a preview-pr23 response", () => {
    const evt = response("preview-pr23.example.test", 302, "/pr-23/admin/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/admin/");
  });

  test("strips multi-digit /pr-N/ prefixes", () => {
    const evt = response("preview-pr12345.example.test", 301, "/pr-12345/blog/foo/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/blog/foo/");
  });

  test("rewrites the bare /pr-N to / so the root index doesn't 404", () => {
    const evt = response("preview-pr7.example.test", 302, "/pr-7/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/");
  });

  test("does not strip a /pr-N/ that doesn't match the host's PR number", () => {
    // S3 only ever 302's within its own bucket prefix, but defend in depth:
    // a /pr-99/ leak on the pr-23 host is suspicious — leave it alone so the
    // browser visibly fails rather than silently being routed somewhere odd.
    const evt = response("preview-pr23.example.test", 302, "/pr-99/admin/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/pr-99/admin/");
  });

  test("leaves absolute URLs (e.g. cross-origin redirects) untouched", () => {
    const evt = response("preview-pr23.example.test", 302, "https://example.com/somewhere");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("https://example.com/somewhere");
  });

  test("no-op on non-redirect responses", () => {
    const evt = response("preview-pr23.example.test", 200);
    handler(evt);
    expect(evt.response.headers.location).toBeUndefined();
  });

  test("no-op on apex/unrelated hosts", () => {
    const evt = response("example.test", 302, "/pr-1/foo/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/pr-1/foo/");
  });

  test("no-op when no Location header is present even on a 3xx", () => {
    const evt = response("preview-pr23.example.test", 304);
    expect(() => handler(evt)).not.toThrow();
    expect(evt.response.headers.location).toBeUndefined();
  });

  test("no-op when host header is missing", () => {
    const evt = response(undefined, 302, "/pr-23/admin/");
    expect(() => handler(evt)).not.toThrow();
    // No host means no PR context, so the prefix isn't recognised and the
    // header passes through unchanged.
    expect(evt.response.headers.location.value).toBe("/pr-23/admin/");
  });

  // ── Per-slug CMS preview hosts (mirror of router function) ───────

  test("strips /cms-posts-foo-bar/ from a 302 Location on a preview-cms-posts-foo-bar response", () => {
    const evt = response(
      "preview-cms-posts-foo-bar.example.test",
      302,
      "/cms-posts-foo-bar/admin/",
    );
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/admin/");
  });

  test("rewrites the bare /cms-<slug> to / so the root index doesn't 404", () => {
    const evt = response("preview-cms-pages-about.example.test", 302, "/cms-pages-about/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/");
  });

  test("does not strip a /cms-<slug>/ that doesn't match the host's slug", () => {
    // A leak of the wrong slug's prefix on a different host should fail
    // visibly rather than silently route to the wrong S3 prefix.
    const evt = response("preview-cms-posts-foo.example.test", 302, "/cms-pages-about/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/cms-pages-about/");
  });

  test("does not cross-strip /pr-N/ on a cms-<slug> host", () => {
    // A pr-23 prefix on a cms-foo host is a misroute — leave it visible.
    const evt = response("preview-cms-posts-foo.example.test", 302, "/pr-23/admin/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/pr-23/admin/");
  });

  test("does not cross-strip /cms-<slug>/ on a pr-N host", () => {
    // Mirror: cms-foo prefix surfacing on a pr-23 host is also a misroute.
    const evt = response("preview-pr23.example.test", 302, "/cms-posts-foo/admin/");
    handler(evt);
    expect(evt.response.headers.location.value).toBe("/cms-posts-foo/admin/");
  });

  // ── X-Robots-Tag injection ───────────────────────────────────────
  // The function adds `X-Robots-Tag: noindex, nofollow` on EVERY
  // response from the preview distribution, regardless of host /
  // status / path. Belt-and-suspenders alongside the per-host
  // robots.txt — header is more authoritative for crawlers that
  // already have a preview URL discovered.

  test("adds X-Robots-Tag: noindex, nofollow on a 200 response", () => {
    const evt = response("preview-pr23.example.test", 200);
    handler(evt);
    expect(evt.response.headers["x-robots-tag"]).toBeDefined();
    expect(evt.response.headers["x-robots-tag"].value).toBe("noindex, nofollow");
  });

  test("adds X-Robots-Tag on a 302 Location response (alongside the strip)", () => {
    const evt = response("preview-pr23.example.test", 302, "/pr-23/admin/");
    handler(evt);
    expect(evt.response.headers["x-robots-tag"].value).toBe("noindex, nofollow");
    // Strip still happened too.
    expect(evt.response.headers.location.value).toBe("/admin/");
  });

  test("adds X-Robots-Tag on a 404 too (covers asset misses)", () => {
    const evt = response("preview-pr23.example.test", 404);
    handler(evt);
    expect(evt.response.headers["x-robots-tag"].value).toBe("noindex, nofollow");
  });

  test("adds X-Robots-Tag on cms-slug hosts", () => {
    const evt = response("preview-cms-posts-foo-bar.example.test", 200);
    handler(evt);
    expect(evt.response.headers["x-robots-tag"].value).toBe("noindex, nofollow");
  });

  test("adds X-Robots-Tag even when the host header is missing", () => {
    // Defensive — preview hosts always have a Host header in practice,
    // but the noindex marking shouldn't depend on host detection. (The
    // production distribution doesn't attach this function at all, so
    // a stray missing-host case here doesn't accidentally noindex prod.)
    const evt = response(undefined, 200);
    handler(evt);
    expect(evt.response.headers["x-robots-tag"].value).toBe("noindex, nofollow");
  });
});
