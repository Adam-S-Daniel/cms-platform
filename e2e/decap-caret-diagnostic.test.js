const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readShell, verifyBundle } = require("./decap-caret-diagnostic");

const fixture = Buffer.from("neutral bundle fixture");
const sri = `sha384-${createHash("sha384").update(fixture).digest("base64")}`;

test("diagnostic derives the one stock pin and platform file order from the local shell", async () => {
  const { pin, scripts } = await readShell();
  expect(scripts.filter(({ src }) => src.startsWith("https://"))).toEqual([pin]);
  expect(scripts.findIndex(({ src }) => src === "confirm-wrap-local-backup.js")).toBeLessThan(scripts.indexOf(pin));
  expect(scripts.findIndex(({ src }) => src === "preview-pane.js")).toBeGreaterThan(scripts.indexOf(pin));
  expect(pin.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
});

test("diagnostic accepts a bundle matching the requested SRI", () => {
  expect(verifyBundle(fixture, sri)).toEqual(fixture);
});

test("diagnostic rejects a changed bundle or missing SRI before routing it", () => {
  expect(() => verifyBundle(Buffer.from("changed fixture"), sri)).toThrow("does not match");
  expect(() => verifyBundle(fixture, undefined)).toThrow("does not match");
});

test("caret discovery selects only eight root cases after fixture placement", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caret-discovery-"));
  try {
    for (const directory of [".", "fixture-site/e2e", "fixture-site-singlepage/e2e"]) {
      const destination = path.join(scratch, directory);
      fs.mkdirSync(destination, { recursive: true });
      for (const filename of ["playwright.caret.config.js", "decap-caret-selection.spec.js", "decap-caret-diagnostic.js"]) {
        fs.copyFileSync(path.join(__dirname, filename), path.join(destination, filename));
      }
    }
    fs.symlinkSync(path.join(__dirname, "node_modules"), path.join(scratch, "node_modules"), "dir");
    const report = JSON.parse(execFileSync(process.execPath, [
      require.resolve("@playwright/test/cli"), "test",
      `--config=${path.join(scratch, "playwright.caret.config.js")}`,
      "--list", "--reporter=json",
    ], { cwd: scratch, encoding: "utf8" }));
    function collectSpecs(suites) {
      return suites.flatMap((suite) => [...(suite.specs || []), ...collectSpecs(suite.suites || [])]);
    }
    const specs = collectSpecs(report.suites);
    expect(report.errors).toEqual([]);
    expect(specs.flatMap((spec) => spec.tests)).toHaveLength(8);
    expect([...new Set(specs.map((spec) => spec.file))]).toEqual(["decap-caret-selection.spec.js"]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
