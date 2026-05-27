// @lane: local — pure-Node parse of the CloudFront FunctionCode YAML; no network
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Pulls the inline FunctionCode of the CloudFront preview-router function out
// of the CloudFormation template, runs it in Node, and asserts each routing
// case. Keeps the template as the single source of truth — no duplicate
// copy of the function body to drift.
//
// blog-slug-literal-lint: allowed: literal slug used for known fixture —
// the `/blog/foo/` strings are synthetic router-input fixtures, not refs
// to real `_posts/*.md` content.

const TEMPLATE_PATH = path.join(__dirname, "..", "infrastructure/bootstrap/template.yaml");

function loadHandler() {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  // Match the `FunctionCode: |` block literal body. The scalar ends when a
  // line returns to outer indentation (two or fewer spaces).
  const match = template.match(/FunctionCode:\s*\|\s*\n((?:[ \t]{8,}.*(?:\n|$))+)/);
  if (!match) {
    throw new Error("Could not locate PreviewRouterFunction.FunctionCode in template.yaml");
  }
  // Dedent the block (block scalars preserve leading spaces past the
  // indicator's indent). 8 spaces is the baseline indentation in this
  // template — strip it so the code runs as plain JS.
  const src = match[1].replace(/^[ \t]{8}/gm, "");
  // Expose `handler` out of a fresh Function scope.
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn handler;`)();
}

function request(host, uri) {
  const req = {
    uri,
    headers: host ? { host: { value: host } } : {},
  };
  return { request: req };
}

test.describe("CloudFront preview-router function", () => {
  const handler = loadHandler();

  test("preview-pr21.adamdaniel.ai rewrites /blog/foo/ to /pr-21/blog/foo/", () => {
    const evt = request("preview-pr21.adamdaniel.ai", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/pr-21/blog/foo/");
  });

  test("rewrites root / to /pr-N/ so S3 website index resolves", () => {
    const evt = request("preview-pr21.adamdaniel.ai", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/pr-21/");
  });

  test("handles multi-digit PR numbers", () => {
    const evt = request("preview-pr12345.adamdaniel.ai", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/pr-12345/blog/foo/");
  });

  test("leaves apex adamdaniel.ai requests alone", () => {
    const evt = request("adamdaniel.ai", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/blog/foo/");
  });

  test("leaves unrelated subdomains alone", () => {
    const evt = request("preview.adamdaniel.ai", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/");
  });

  test("does not rewrite when the subdomain almost matches", () => {
    const evt = request("preview-pr21.example.com", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/blog/foo/");
  });

  test("returns the request unchanged when no host header is present", () => {
    const evt = request(undefined, "/blog/foo/");
    expect(() => handler(evt)).not.toThrow();
    expect(evt.request.uri).toBe("/blog/foo/");
  });

  // ── Per-slug CMS preview hosts ───────────────────────────────────
  // preview-cms-<slug>.adamdaniel.ai → /cms-<slug>/<uri>. The slug is
  // Decap's `cms/<col>/<entry-slug>` head ref with `/` replaced by `-`.
  // Editors get a stable URL that survives across draft cycles for
  // the same entry. See docs/preview-pr-ruleset-spike.md.

  test("preview-cms-posts-foo-bar.adamdaniel.ai rewrites /blog/foo-bar/ to /cms-posts-foo-bar/blog/foo-bar/", () => {
    const evt = request("preview-cms-posts-foo-bar.adamdaniel.ai", "/blog/foo-bar/");
    handler(evt);
    expect(evt.request.uri).toBe("/cms-posts-foo-bar/blog/foo-bar/");
  });

  test("rewrites root / to /cms-<slug>/ for the cms preview host", () => {
    const evt = request("preview-cms-pages-about.adamdaniel.ai", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/cms-pages-about/");
  });

  test("handles long collection-prefixed slugs", () => {
    const evt = request(
      "preview-cms-projects-some-very-long-project-title.adamdaniel.ai",
      "/projects/some-very-long-project-title/",
    );
    handler(evt);
    expect(evt.request.uri).toBe(
      "/cms-projects-some-very-long-project-title/projects/some-very-long-project-title/",
    );
  });

  test("rejects uppercase slugs (DNS labels are case-insensitive but our regex is lower-only)", () => {
    // Uppercase in the slug would mean S3 prefix mismatch (S3 keys are
    // case-sensitive and we always sync to lowercase prefixes). Defend
    // by leaving the URI alone — the request 404s rather than silently
    // routing to the wrong place.
    const evt = request("preview-cms-Posts-FOO.adamdaniel.ai", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/");
  });

  test("preview-cms-<slug> on a wrong domain doesn't rewrite", () => {
    const evt = request("preview-cms-posts-foo.example.com", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/");
  });
});
