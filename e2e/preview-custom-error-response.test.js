// @lane: local — pure-fs lint, parses the CloudFormation template with the
// real `yaml` package (never a regex over source); no network, no browser.
//
// cms-platform#324 — every 404 on a PREVIEW environment used to fall through
// to S3's raw website error page (bucket key layout + RequestId, plus a
// second nested "could not retrieve custom error document" failure) because
// ProductionDistribution had a `CustomErrorResponses` block and
// PreviewDistribution had none at all. Preview links are exactly what get
// sent to a non-technical reviewer, so this is a regression that must never
// come back silently.
//
// This lint locks the fix's SHAPE in infrastructure/bootstrap/template.yaml:
//   - PreviewDistribution has its OWN CustomErrorResponses list;
//   - it covers both 404 and 403 (S3 website error documents surface as
//     403s too, for a missing-key request against a bucket with no public
//     ListBucket — same as production's block, mirrored);
//   - every entry forces ResponseCode: 404 with ErrorCachingMinTTL: 0 (the
//     production shape — a cached false-404 would keep serving stale once
//     the real object exists);
//   - the ResponsePagePath is a BUCKET-ROOT path (a single path segment,
//     not nested under a `pr-<N>/` or `cms-<slug>/` prefix). CloudFront
//     fetches ResponsePagePath directly from the origin at the CloudFront
//     layer — the viewer-request Function that prepends those prefixes for
//     a normal client request does NOT re-run for that fetch (see the
//     template's own comment on PreviewDistribution) — so a prefixed path
//     could never resolve, and reusing `/404.html` would collide with a
//     real per-PR object at that same relative key;
//   - ProductionDistribution's existing block is still intact, unmoved and
//     unchanged. Without this, "fixing" #324 by relocating prod's block to
//     preview (rather than adding preview's own) would pass every assertion
//     above while quietly breaking production 404s instead.
//
// A NOTE ON PARSING CLOUDFORMATION YAML. CloudFormation templates carry
// short-form intrinsic tags — `!Sub`, `!Ref`, `!GetAtt`, `!If`, … — that are
// not part of core YAML. Empirically (verified against the `yaml` package
// 2.9.0 pinned in this repo's e2e/package-lock.json, the same version
// pin-comment-rules.js's header verifies against): a bare `YAML.parse()`
// does NOT throw on an unresolved tag — it resolves the tagged node to its
// underlying scalar/sequence/mapping value (dropping the tag) and reports
// the drop as a WARNING, not an error, so `errors` stays empty and parsing
// succeeds. The only visible side effect is a noisy `process.emitWarning`
// per unresolved tag; `{ logLevel: "silent" }` suppresses that without
// changing what parses or what value comes back. That is sufficient here —
// none of the keys this lint reads (ErrorCode / ResponseCode /
// ResponsePagePath / ErrorCachingMinTTL, on both distributions) are ever
// themselves `!Sub`/`!Ref`/`!GetAtt`'d in this template, so the dropped-tag
// values are exactly the plain scalars a hand reader would expect. No
// `customTags` schema is needed for that reason — but if a future edit ever
// wraps one of those four keys in an intrinsic, the affected value would
// silently become that intrinsic's stringified argument instead of throwing,
// which is worth knowing before trusting a diff here.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const TEMPLATE_PATH = path.join(__dirname, "..", "infrastructure/bootstrap/template.yaml");

function loadTemplate() {
  const text = fs.readFileSync(TEMPLATE_PATH, "utf8");
  return YAML.parse(text, { logLevel: "silent" });
}

function distributionConfig(template, logicalId) {
  const resource = template.Resources && template.Resources[logicalId];
  if (!resource) {
    throw new Error(`${logicalId} not found in ${TEMPLATE_PATH}`);
  }
  expect(resource.Type, `${logicalId}.Type`).toBe("AWS::CloudFront::Distribution");
  const config = resource.Properties && resource.Properties.DistributionConfig;
  if (!config) {
    throw new Error(`${logicalId}.Properties.DistributionConfig missing`);
  }
  return config;
}

// A ResponsePagePath is "bucket-root" when it names exactly one path
// segment off the leading slash — i.e. it cannot be nested under a
// `pr-<N>/` or `cms-<slug>/` object-key prefix, which is how a per-PR/
// per-slug preview stores everything else in this bucket (see
// PreviewRouterFunction's FunctionCode a few lines above
// PreviewDistribution in the template). Checked two ways on purpose: the
// segment-count check alone would already reject `/pr-23/404.html` (two
// segments), and the explicit prefix check documents exactly WHY, rather
// than leaving a future reader to re-derive it from a regex.
function isBucketRootPath(p) {
  return (
    typeof p === "string" &&
    /^\/[^/]+$/.test(p) &&
    !/^\/pr-/.test(p) &&
    !/^\/cms-/.test(p)
  );
}

test.describe("PreviewDistribution.CustomErrorResponses (cms-platform#324)", () => {
  const template = loadTemplate();
  const previewConfig = distributionConfig(template, "PreviewDistribution");
  const productionConfig = distributionConfig(template, "ProductionDistribution");

  test("PreviewDistribution declares a CustomErrorResponses list", () => {
    expect(
      Array.isArray(previewConfig.CustomErrorResponses),
      "PreviewDistribution.Properties.DistributionConfig.CustomErrorResponses must be a list " +
        "— without one, every preview 404 falls through to S3's raw website error page " +
        "(cms-platform#324).",
    ).toBe(true);
    expect(previewConfig.CustomErrorResponses.length).toBeGreaterThan(0);
  });

  test("covers both 404 and 403", () => {
    const codes = previewConfig.CustomErrorResponses.map((e) => e.ErrorCode).sort();
    expect(codes).toEqual([403, 404]);
  });

  test("every entry maps to ResponseCode 404 with ErrorCachingMinTTL 0", () => {
    for (const entry of previewConfig.CustomErrorResponses) {
      expect(entry.ResponseCode, `ErrorCode ${entry.ErrorCode} .ResponseCode`).toBe(404);
      expect(
        entry.ErrorCachingMinTTL,
        `ErrorCode ${entry.ErrorCode} .ErrorCachingMinTTL — must be 0, or a real object ` +
          "deployed after this response is cached would keep serving the error for the " +
          "TTL window",
      ).toBe(0);
    }
  });

  test("ResponsePagePath is a bucket-root path, not nested under a pr-<N>/ or cms-<slug>/ prefix", () => {
    for (const entry of previewConfig.CustomErrorResponses) {
      expect(
        isBucketRootPath(entry.ResponsePagePath),
        `ErrorCode ${entry.ErrorCode} .ResponsePagePath = ${JSON.stringify(entry.ResponsePagePath)} ` +
          "— CloudFront fetches ResponsePagePath directly from the origin and does not " +
          "re-run the viewer-request prefix rewrite for that fetch, so a path nested under " +
          "a pr-<N>/ or cms-<slug>/ prefix (or reusing the per-PR /404.html key) could never " +
          "resolve; it must be a single root-level segment instead.",
      ).toBe(true);
    }
  });

  test("all preview entries share the same ResponsePagePath (one shared bucket-root object)", () => {
    const paths = new Set(previewConfig.CustomErrorResponses.map((e) => e.ResponsePagePath));
    expect(
      paths.size,
      "404 and 403 should point at the SAME bucket-root object — deploy-preview.yml's " +
        "\"Ensure preview 404 error page exists at bucket root\" step only maintains one.",
    ).toBe(1);
  });

  test("ProductionDistribution's existing CustomErrorResponses block is unchanged", () => {
    // Locks the pre-#324 shape so this fix cannot be "landed" by relocating
    // production's block to preview instead of adding preview's own —
    // that would pass every assertion above while silently breaking
    // production's 404 handling.
    expect(productionConfig.CustomErrorResponses).toEqual([
      { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: "/404.html", ErrorCachingMinTTL: 0 },
      { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html", ErrorCachingMinTTL: 0 },
    ]);
  });
});
