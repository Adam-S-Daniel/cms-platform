// Shared CMS test-target resolver.
//
// Every real-backend (`@lane: real`) CMS spec drives a deployed Decap
// admin and asserts against a deployed public URL. Historically each
// spec hardcoded its own host triplet — `PROD_HOST = "https://
// adamdaniel.ai"` + `${PROD_HOST}/admin/`, or a `PR_NUMBER ?
// https://preview-pr${PR_NUMBER}.adamdaniel.ai : ""` guard — and picked
// `PILL_PROD` vs `PILL_PREVIEW` by hand. That meant the prod and preview
// surfaces drifted independently. This module is the single source of
// truth so the publish-loop, delete, and media specs resolve their
// target identically.
//
// A "target" is the shape every consumer needs:
//   { host, adminUrl, pillId, isPreview, prNumber, label }
// `host` is "" only for an unresolved preview (no PR number) so callers
// can self-skip exactly as the old `PR_NUMBER ? … : ""` guards did.
// The public URL is intentionally NOT part of the target: each spec
// appends its own path (canary.publicPath, a `_posts/` slug, the blog
// permalink) onto `host`.

const { PILL_PROD, PILL_PREVIEW } = require("./deploy-pill");

const PROD_HOST = process.env.CMS_PROD_URL || "";
const CMS_APEX = process.env.CMS_APEX || "";

function previewHostFor(prNumber) {
  return `https://preview-pr${prNumber}.${CMS_APEX}`;
}

// Fixed prod target — specs that only ever drive prod/main
// (cms-publish-loop, cms-publish-loop-prod-mutate, cms-delete-published,
// cms-unpublish-republish, cms-tags-lifecycle).
function prodTarget() {
  return {
    host: PROD_HOST,
    adminUrl: `${PROD_HOST}/admin/`,
    pillId: PILL_PROD,
    isPreview: false,
    prNumber: "",
    label: "prod",
  };
}

// Fixed preview target — specs that only ever drive a PR preview
// (cms-publish-loop-preview, cms-delete-published-preview). The PR
// number resolves from an explicit arg, else PR_NUMBER /
// GITHUB_PR_NUMBER. `host` is "" when no number is available so the
// caller self-skips, preserving the old hand-rolled guard's behaviour.
function previewTarget(prNumber, env = process.env) {
  const n = prNumber || env.PR_NUMBER || env.GITHUB_PR_NUMBER || "";
  const host = n ? previewHostFor(n) : "";
  return {
    host,
    adminUrl: host ? `${host}/admin/` : "",
    pillId: PILL_PREVIEW,
    isPreview: true,
    prNumber: n,
    label: n ? `preview-pr${n}` : "preview(unresolved)",
  };
}

// Parameterized resolution — specs that can target either surface
// (cms-media-roundtrip). `CMS_TARGET=preview` (with a resolvable PR
// number) selects the preview surface; anything else — including unset
// — keeps the historical prod default, so the existing prod workflows
// stay behaviour-preserving without setting any new env.
function resolveCmsTarget(env = process.env) {
  const want = String(env.CMS_TARGET || "prod").toLowerCase();
  if (want === "preview") {
    const t = previewTarget("", env);
    if (!t.host) {
      throw new Error(
        "CMS_TARGET=preview but neither PR_NUMBER nor GITHUB_PR_NUMBER " +
          "is set; cannot resolve a preview-pr<N> host.",
      );
    }
    return t;
  }
  return prodTarget();
}

module.exports = {
  PROD_HOST,
  previewHostFor,
  prodTarget,
  previewTarget,
  resolveCmsTarget,
};
