// @lane: local — pure-Node unit tests for decap-pat.js's HOST_REPO env
// derivation (issue #185: a hardcoded HOST_REPO cross-wired every OTHER
// consumer's host loop into Adam-S-Daniel/adamdaniel.ai, producing 403s
// on jodidaniel.com's host loop). No browser, no network — HOST_REPO is
// a module-load-time constant, so each case clears the require cache and
// re-requires the module under a controlled process.env to observe a
// fresh evaluation.
const { test, expect } = require("./base");

const MODULE_PATH = require.resolve("./decap-pat");
const ADAMDANIEL_LITERAL = "Adam-S-Daniel/adamdaniel.ai";

function loadHostRepo() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH).HOST_REPO;
}

test.describe("decap-pat HOST_REPO — env-derived (#185)", () => {
  let savedCmsRepo;
  let savedGithubRepository;

  test.beforeEach(() => {
    savedCmsRepo = process.env.CMS_REPO;
    savedGithubRepository = process.env.GITHUB_REPOSITORY;
  });

  test.afterEach(() => {
    if (savedCmsRepo === undefined) delete process.env.CMS_REPO;
    else process.env.CMS_REPO = savedCmsRepo;
    if (savedGithubRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = savedGithubRepository;
    // Leave the module cache pointed at a fresh (real-env) evaluation for
    // whatever runs next in this worker.
    delete require.cache[MODULE_PATH];
  });

  test("CMS_REPO set → HOST_REPO resolves to it, even with GITHUB_REPOSITORY also set", () => {
    // Mirrors the loop workflows, which export CMS_REPO: ${{ github.repository }}
    // — the consuming site's own repo, not the platform's.
    process.env.CMS_REPO = "Adam-S-Daniel/jodidaniel.com";
    process.env.GITHUB_REPOSITORY = "Adam-S-Daniel/cms-platform";
    expect(loadHostRepo()).toBe("Adam-S-Daniel/jodidaniel.com");
  });

  test("CMS_REPO unset, GITHUB_REPOSITORY set → HOST_REPO resolves to GITHUB_REPOSITORY", () => {
    delete process.env.CMS_REPO;
    process.env.GITHUB_REPOSITORY = "Adam-S-Daniel/jodidaniel.com";
    expect(loadHostRepo()).toBe("Adam-S-Daniel/jodidaniel.com");
  });

  test("neither set → HOST_REPO falls back to the historical adamdaniel.ai literal (local dev)", () => {
    delete process.env.CMS_REPO;
    delete process.env.GITHUB_REPOSITORY;
    expect(loadHostRepo()).toBe(ADAMDANIEL_LITERAL);
  });
});
