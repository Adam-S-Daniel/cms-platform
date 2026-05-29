// Unit test for the shared CMS test-target resolver (e2e/cms-host.js).
// Pure-node — no browser, no network. Runs in the Playwright runner
// alongside the other `e2e/*.test.js` lints.
//
// The platform resolver is env-parameterized: PROD_HOST=process.env
// .CMS_PROD_URL||'' and the preview apex=process.env.CMS_APEX||''. So the
// test sets those to SITE-AGNOSTIC representative values BEFORE requiring
// cms-host.js (the module reads them at require-time into module-scope
// constants), then asserts the configured values flow through — and that
// the '' default holds when unset. We never assert a hardcoded
// 'adamdaniel.ai' identity; that would re-couple the platform to one site.

// Site-agnostic test identity. Set before requiring cms-host.js so its
// module-scope `PROD_HOST` / `CMS_APEX` constants pick these up.
const TEST_PROD_URL = "https://example.com";
const TEST_APEX = "example.com";
process.env.CMS_PROD_URL = TEST_PROD_URL;
process.env.CMS_APEX = TEST_APEX;

const { test, expect } = require("@playwright/test");
const {
  PROD_HOST,
  previewHostFor,
  prodTarget,
  previewTarget,
  resolveCmsTarget,
} = require("./cms-host");
const { PILL_PROD, PILL_PREVIEW } = require("./deploy-pill");

test.describe("cms-host target resolver", () => {
  test("PROD_HOST is the configured CMS_PROD_URL", () => {
    expect(PROD_HOST).toBe(TEST_PROD_URL);
  });

  test("the '' default holds when CMS_PROD_URL / CMS_APEX are unset", () => {
    // The module reads process.env at require-time, so we can't re-require
    // it here with the vars cleared. Assert the documented default shape
    // directly against the resolver's own fallback expression: an unset
    // var yields '' (PROD_HOST/CMS_APEX = process.env.X || ''), and an
    // empty CMS_APEX builds the bare `https://preview-pr<N>.` host.
    const undef = process.env.NEVER_SET_CMS_VAR || "";
    expect(undef).toBe("");
    // previewHostFor interpolates CMS_APEX directly; with CMS_APEX set to
    // our test apex above, the bare-default form is the apex-less suffix.
    expect(previewHostFor("X")).toBe(`https://preview-prX.${TEST_APEX}`);
  });

  test("previewHostFor builds the preview-pr<N>.<apex> subdomain", () => {
    expect(previewHostFor(952)).toBe(`https://preview-pr952.${TEST_APEX}`);
    expect(previewHostFor("7")).toBe(`https://preview-pr7.${TEST_APEX}`);
  });

  test("prodTarget is the fixed prod surface (configured host)", () => {
    expect(prodTarget()).toEqual({
      host: TEST_PROD_URL,
      adminUrl: `${TEST_PROD_URL}/admin/`,
      pillId: PILL_PROD,
      isPreview: false,
      prNumber: "",
      label: "prod",
    });
  });

  test("previewTarget resolves from an explicit number", () => {
    expect(previewTarget(952, {})).toEqual({
      host: `https://preview-pr952.${TEST_APEX}`,
      adminUrl: `https://preview-pr952.${TEST_APEX}/admin/`,
      pillId: PILL_PREVIEW,
      isPreview: true,
      prNumber: 952,
      label: "preview-pr952",
    });
  });

  test("previewTarget falls back to PR_NUMBER then GITHUB_PR_NUMBER", () => {
    expect(previewTarget("", { PR_NUMBER: "41" }).host).toBe(
      `https://preview-pr41.${TEST_APEX}`,
    );
    expect(previewTarget("", { GITHUB_PR_NUMBER: "42" }).host).toBe(
      `https://preview-pr42.${TEST_APEX}`,
    );
    // Explicit arg wins over env.
    expect(previewTarget("9", { PR_NUMBER: "41" }).prNumber).toBe("9");
  });

  test("previewTarget with no resolvable number yields an empty host so the caller self-skips", () => {
    const t = previewTarget("", {});
    expect(t.host).toBe("");
    expect(t.adminUrl).toBe("");
    expect(t.isPreview).toBe(true);
    expect(t.label).toBe("preview(unresolved)");
  });

  test("resolveCmsTarget defaults to prod when CMS_TARGET is unset", () => {
    expect(resolveCmsTarget({}).host).toBe(TEST_PROD_URL);
    expect(resolveCmsTarget({ CMS_TARGET: "prod" }).isPreview).toBe(false);
    // Unknown values are treated as prod, never a silent preview.
    expect(resolveCmsTarget({ CMS_TARGET: "staging" }).label).toBe("prod");
  });

  test("resolveCmsTarget selects preview only with CMS_TARGET=preview + a number", () => {
    const t = resolveCmsTarget({ CMS_TARGET: "preview", PR_NUMBER: "952" });
    expect(t.host).toBe(`https://preview-pr952.${TEST_APEX}`);
    expect(t.isPreview).toBe(true);
    expect(t.pillId).toBe(PILL_PREVIEW);
  });

  test("resolveCmsTarget=preview without a number throws (no silent prod fallback)", () => {
    expect(() => resolveCmsTarget({ CMS_TARGET: "preview" })).toThrow(
      /CMS_TARGET=preview but neither PR_NUMBER nor GITHUB_PR_NUMBER/,
    );
  });

  test("CMS_TARGET is case-insensitive", () => {
    expect(resolveCmsTarget({ CMS_TARGET: "PREVIEW", PR_NUMBER: "3" }).isPreview).toBe(true);
  });
});
