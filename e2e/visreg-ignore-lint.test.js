// @lane: local — pure-fs lint tying the visreg-ignore attribute to its consumer
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Locks the deploy-metadata exclusion seam of the visual-regression text
// check. The admin shell's deployed-commit pill shows `<sha> <deploy time>`
// on prod but nothing in the pipeline's local CI build (no commit.json), so
// without an exclusion EVERY salient PR flags /admin/ and forces the manual
// review gate — observed live on the very first run of the text check
// (adamdaniel.ai#2554, v0.1.59 bump).
//
// The contract has three halves that must not drift apart:
//   1. deployment-metadata elements carry [data-visreg-ignore];
//   2. regression-video.spec.js strips those nodes AND a fallback id list —
//      the id fallback exists because of version skew: prod serves the
//      PREVIOUS release's markup, so a marker retrofitted onto a
//      pre-existing element doesn't exist on prod until prod itself ships
//      it (observed live: adamdaniel.ai#2560);
//   3. the ids in that fallback list match the ids the theme sources
//      actually assign — a silent rename reopens the version-skew leak.

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test.describe("visual-regression: deploy-metadata text exclusion", () => {
  test("the admin commit pills carry data-visreg-ignore", () => {
    for (const shell of ["theme/admin/index.html", "theme/admin/index-local.html"]) {
      const s = read(shell);
      expect(s, `${shell} must create the commit pill`).toContain("cms-commit-pill");
      expect(
        s,
        `${shell}'s commit pill must be marked data-visreg-ignore — its sha/date ` +
          "differs between prod and a CI build by definition",
      ).toMatch(/data-visreg-ignore/);
    }
  });

  test("the deploy-status pill carries data-visreg-ignore", () => {
    expect(read("theme/admin/deploy-status-pill.js")).toMatch(/data-visreg-ignore/);
  });

  test("the text capture strips [data-visreg-ignore] nodes and the id fallback list", () => {
    const s = read("e2e/regression-video.spec.js");
    expect(
      s,
      "VISREG_IGNORE_SELECTOR must still include \"[data-visreg-ignore]\" — the extensible " +
        "marker any future deployment-metadata element opts into",
    ).toContain('"[data-visreg-ignore]"');
    for (const id of ["#cms-commit-pill", "#cms-prod-status-pill", "#cms-preview-build-pill"]) {
      expect(
        s,
        `VISREG_IGNORE_SELECTOR must list "${id}" — without it, a consumer's first bump past ` +
          "the marker's release leaks that pill's deployment metadata into prod's text dump " +
          "(version skew, adamdaniel.ai#2560)",
      ).toContain(`"${id}"`);
    }
    expect(
      s,
      "writeVisibleText's page.evaluate must be called with VISREG_IGNORE_SELECTOR as its " +
        "argument — otherwise the id fallback list is defined but never applied to the dump",
    ).toContain("}, VISREG_IGNORE_SELECTOR);");
  });

  test("the fallback ids match the theme sources", () => {
    expect(
      read("theme/admin/index.html"),
      "the commit pill's id must stay cms-commit-pill — renaming it without updating " +
        "regression-video.spec.js's fallback list silently reopens the version-skew leak",
    ).toContain("a.id = 'cms-commit-pill'");

    const pillSrc = read("theme/admin/deploy-status-pill.js");
    expect(
      pillSrc,
      "PROD_PILL_ID must stay cms-prod-status-pill — renaming it without updating " +
        "regression-video.spec.js's fallback list silently reopens the version-skew leak",
    ).toContain('var PROD_PILL_ID = "cms-prod-status-pill"');
    expect(
      pillSrc,
      "PREVIEW_PILL_ID must stay cms-preview-build-pill — renaming it without updating " +
        "regression-video.spec.js's fallback list silently reopens the version-skew leak",
    ).toContain('var PREVIEW_PILL_ID = "cms-preview-build-pill"');
  });
});
