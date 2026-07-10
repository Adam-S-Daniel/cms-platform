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
// The contract has two halves that must not drift apart:
//   1. deployment-metadata elements carry [data-visreg-ignore];
//   2. regression-video.spec.js strips those nodes before the innerText dump.

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

  test("the text capture strips [data-visreg-ignore] nodes", () => {
    const s = read("e2e/regression-video.spec.js");
    expect(
      s,
      "writeVisibleText must exclude [data-visreg-ignore] nodes from the dump",
    ).toMatch(/querySelectorAll\("\[data-visreg-ignore\]"\)/);
  });
});
