// @lane: local — pure-fs invariants for the Playwright image-drift guard (#1723 Cat 4)
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  expectedPlaywrightVersion,
  scanFileForTags,
  findDriftMismatches,
} = require("../scripts/check-playwright-image-drift");

const REPO_ROOT = path.resolve(__dirname, "..");

// Build a throwaway repo skeleton with a given lockfile version, a
// Dockerfile ARG pin, and one workflow image ref, so the guard's drift
// detection can be exercised on synthetic inputs.
function scaffold({ lockVersion, dockerfileArg, workflowTag }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-drift-"));
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      packages: { "node_modules/@playwright/test": { version: lockVersion } },
    }),
  );
  fs.mkdirSync(path.join(dir, ".github", "ci-runner"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "ci-runner", "Dockerfile"),
    `ARG PLAYWRIGHT_IMAGE_TAG=${dockerfileArg}\nFROM mcr.microsoft.com/playwright:\${PLAYWRIGHT_IMAGE_TAG}\n`,
  );
  if (workflowTag) {
    fs.writeFileSync(
      path.join(dir, ".github", "workflows", "x.yml"),
      `jobs:\n  j:\n    container:\n      image: mcr.microsoft.com/playwright:${workflowTag}\n`,
    );
  }
  return dir;
}

test.describe("playwright image-drift guard (#1723 Cat 4)", () => {
  test("the real repo is drift-free (Dockerfile ARG matches the lockfile)", () => {
    const { expected, mismatches } = findDriftMismatches(REPO_ROOT);
    expect(expected, "lockfile version resolves").toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      mismatches,
      `Playwright image pins drifted from the lockfile (${expected}): ` +
        JSON.stringify(mismatches),
    ).toEqual([]);
    // And the resolver agrees with the lockfile read directly.
    expect(expectedPlaywrightVersion(REPO_ROOT)).toBe(expected);
  });

  test("the guard reads the ci-runner Dockerfile ARG (the pin the old guard missed)", () => {
    // The whole point of #1723 Cat 4: the ARG pin must be SCANNED. Prove
    // the scanner sees the real Dockerfile's PLAYWRIGHT_IMAGE_TAG.
    const tags = scanFileForTags(path.join(REPO_ROOT, ".github", "ci-runner", "Dockerfile"));
    expect(tags.length, "Dockerfile must contribute at least one scanned tag").toBeGreaterThan(0);
    expect(tags.every((t) => /^\d+\.\d+\.\d+$/.test(t.version))).toBe(true);
  });

  test("detects a Dockerfile ARG that lags the lockfile (the Cat 4 failure mode)", () => {
    const dir = scaffold({ lockVersion: "1.60.0", dockerfileArg: "v1.59.1-noble" });
    try {
      const { expected, mismatches } = findDriftMismatches(dir);
      expect(expected).toBe("1.60.0");
      expect(mismatches.length).toBe(1);
      expect(mismatches[0].file).toMatch(/Dockerfile$/);
      expect(mismatches[0].found).toBe("1.59.1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a drifted workflow image ref too", () => {
    const dir = scaffold({
      lockVersion: "1.60.0",
      dockerfileArg: "v1.60.0-noble",
      workflowTag: "v1.58.0-noble",
    });
    try {
      const { mismatches } = findDriftMismatches(dir);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0].file).toMatch(/\.github\/workflows\/x\.yml$/);
      expect(mismatches[0].found).toBe("1.58.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes when both the Dockerfile ARG and the workflow ref match", () => {
    const dir = scaffold({
      lockVersion: "1.60.0",
      dockerfileArg: "v1.60.0-noble",
      workflowTag: "v1.60.0-noble",
    });
    try {
      expect(findDriftMismatches(dir).mismatches).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
