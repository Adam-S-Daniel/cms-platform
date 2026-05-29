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
// Synthetic apex baked into the body in place of the Fn::Sub'd
// ${ProductionDomainName}, so the parameterized host-matching runs as deployed.
const TEST_APEX = "example.test";

function loadHandler() {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  // Match the `FunctionCode: |` (or `FunctionCode: !Sub |`) block literal body.
  // The apex is baked in via Fn::Sub at deploy, so the scalar carries the
  // `!Sub` tag. The block ends when a line returns to outer indentation.
  const match = template.match(/FunctionCode:\s*(?:!Sub\s+)?\|\s*\n((?:[ \t]{8,}.*(?:\n|$))+)/);
  if (!match) {
    throw new Error("Could not locate PreviewRouterFunction.FunctionCode in template.yaml");
  }
  // Dedent the block (block scalars preserve leading spaces past the
  // indicator's indent). 8 spaces is the baseline indentation in this
  // template — strip it so the code runs as plain JS. Then simulate Fn::Sub by
  // substituting the only ${...} in the body — the injected apex domain.
  const src = match[1]
    .replace(/^[ \t]{8}/gm, "")
    .replace(/\$\{ProductionDomainName\}/g, TEST_APEX);
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

  test("preview-pr21.example.test rewrites /blog/foo/ to /pr-21/blog/foo/", () => {
    const evt = request("preview-pr21.example.test", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/pr-21/blog/foo/");
  });

  test("rewrites root / to /pr-N/ so S3 website index resolves", () => {
    const evt = request("preview-pr21.example.test", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/pr-21/");
  });

  test("handles multi-digit PR numbers", () => {
    const evt = request("preview-pr12345.example.test", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/pr-12345/blog/foo/");
  });

  test("leaves apex example.test requests alone", () => {
    const evt = request("example.test", "/blog/foo/");
    handler(evt);
    expect(evt.request.uri).toBe("/blog/foo/");
  });

  test("leaves unrelated subdomains alone", () => {
    const evt = request("preview.example.test", "/");
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
  // preview-cms-<slug>.example.test → /cms-<slug>/<uri>. The slug is
  // Decap's `cms/<col>/<entry-slug>` head ref with `/` replaced by `-`.
  // Editors get a stable URL that survives across draft cycles for
  // the same entry. See docs/preview-pr-ruleset-spike.md.

  test("preview-cms-posts-foo-bar.example.test rewrites /blog/foo-bar/ to /cms-posts-foo-bar/blog/foo-bar/", () => {
    const evt = request("preview-cms-posts-foo-bar.example.test", "/blog/foo-bar/");
    handler(evt);
    expect(evt.request.uri).toBe("/cms-posts-foo-bar/blog/foo-bar/");
  });

  test("rewrites root / to /cms-<slug>/ for the cms preview host", () => {
    const evt = request("preview-cms-pages-about.example.test", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/cms-pages-about/");
  });

  test("handles long collection-prefixed slugs", () => {
    const evt = request(
      "preview-cms-projects-some-very-long-project-title.example.test",
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
    const evt = request("preview-cms-Posts-FOO.example.test", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/");
  });

  test("preview-cms-<slug> on a wrong domain doesn't rewrite", () => {
    const evt = request("preview-cms-posts-foo.example.com", "/");
    handler(evt);
    expect(evt.request.uri).toBe("/");
  });
});
