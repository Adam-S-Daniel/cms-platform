// Unit test for the shared CMS test-target resolver (e2e/cms-host.js).
// Pure-node — no browser, no network. Runs in the Playwright runner
// alongside the other `e2e/*.test.js` lints.

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
  test("PROD_HOST is the canonical apex", () => {
    expect(PROD_HOST).toBe("https://adamdaniel.ai");
  });

  test("previewHostFor builds the preview-pr<N> subdomain", () => {
    expect(previewHostFor(952)).toBe("https://preview-pr952.adamdaniel.ai");
    expect(previewHostFor("7")).toBe("https://preview-pr7.adamdaniel.ai");
  });

  test("prodTarget is the fixed prod surface", () => {
    expect(prodTarget()).toEqual({
      host: "https://adamdaniel.ai",
      adminUrl: "https://adamdaniel.ai/admin/",
      pillId: PILL_PROD,
      isPreview: false,
      prNumber: "",
      label: "prod",
    });
  });

  test("previewTarget resolves from an explicit number", () => {
    expect(previewTarget(952, {})).toEqual({
      host: "https://preview-pr952.adamdaniel.ai",
      adminUrl: "https://preview-pr952.adamdaniel.ai/admin/",
      pillId: PILL_PREVIEW,
      isPreview: true,
      prNumber: 952,
      label: "preview-pr952",
    });
  });

  test("previewTarget falls back to PR_NUMBER then GITHUB_PR_NUMBER", () => {
    expect(previewTarget("", { PR_NUMBER: "41" }).host).toBe("https://preview-pr41.adamdaniel.ai");
    expect(previewTarget("", { GITHUB_PR_NUMBER: "42" }).host).toBe(
      "https://preview-pr42.adamdaniel.ai",
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
    expect(resolveCmsTarget({}).host).toBe("https://adamdaniel.ai");
    expect(resolveCmsTarget({ CMS_TARGET: "prod" }).isPreview).toBe(false);
    // Unknown values are treated as prod, never a silent preview.
    expect(resolveCmsTarget({ CMS_TARGET: "staging" }).label).toBe("prod");
  });

  test("resolveCmsTarget selects preview only with CMS_TARGET=preview + a number", () => {
    const t = resolveCmsTarget({ CMS_TARGET: "preview", PR_NUMBER: "952" });
    expect(t.host).toBe("https://preview-pr952.adamdaniel.ai");
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
