// @lane: local — pure-fs unit test for the single-page loop detector (#1068)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const { skipNotice, detect, main } = require("./single-page-detect");

function siteWith(configText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-page-detect-"));
  if (configText !== null) fs.writeFileSync(path.join(dir, "_config.yml"), configText);
  return dir;
}

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join("") };
}

test.describe("single-page loop detector (#1068)", () => {
  test("cms.base_collections: [] is a single-page site", () => {
    const siteRoot = siteWith("cms:\n  base_collections: []\n");
    const r = detect({ siteRoot, repo: "example-owner/example-site", loopName: "media round-trip" });
    expect(r.singlePage).toBe(true);
    expect(r.notice).toContain("example-owner/example-site");
    expect(r.notice).toContain("media round-trip");
    expect(r.notice).toContain("cms-publish-loop-host");
    expect(r.notice.startsWith("::notice")).toBe(true);
  });

  test("an unset or non-empty keep-list is a full site and prints no notice", () => {
    for (const cfg of [
      "title: x\n",
      "cms:\n  base_collections: [posts]\n",
      "cms:\n  base_collections:\n    - posts\n    - tags\n",
    ]) {
      const r = detect({ siteRoot: siteWith(cfg), repo: "o/r", loopName: "l" });
      expect(r, cfg).toEqual({ singlePage: false, notice: "" });
    }
  });

  test("an unreadable or missing _config.yml fails open to a full site", () => {
    expect(detect({ siteRoot: siteWith(null), repo: "o/r", loopName: "l" }).singlePage).toBe(false);
  });

  test("main writes the step output and the notice, and never throws", () => {
    const siteRoot = siteWith("cms:\n  base_collections: []\n");
    const outFile = path.join(siteRoot, "gh-output");
    const out = sink();
    const r = main(
      { SITE_ROOT: siteRoot, GITHUB_REPOSITORY: "o/r", LOOP_NAME: "prod", GITHUB_OUTPUT: outFile },
      out,
    );
    expect(r.line).toBe("single_page=true");
    expect(fs.readFileSync(outFile, "utf8")).toBe("single_page=true\n");
    expect(out.text()).toContain("o/r");

    const full = siteWith("cms:\n  base_collections: [posts]\n");
    const outFull = path.join(full, "gh-output");
    const out2 = sink();
    main({ SITE_ROOT: full, GITHUB_OUTPUT: outFull }, out2);
    expect(fs.readFileSync(outFull, "utf8")).toBe("single_page=false\n");
    expect(out2.text()).toBe("");
  });

  test("a missing SITE_ROOT warns and fails open", () => {
    const out = sink();
    expect(main({}, out).singlePage).toBe(false);
    expect(out.text()).toContain("::warning::");
  });

  test("skipNotice falls back to a generic site name", () => {
    expect(skipNotice("", "x")).toContain("this site is a single-page site");
  });
});
