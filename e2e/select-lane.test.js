// @lane: local — pure-Node unit tests for the @lane: directive parser + filter
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseSpecDirectives,
  parseLaneDirective,
  filterByLane,
  selectSpecs,
} = require("./select-specs");

// ── @lane: directive parser ─────────────────────────────────────────
//
// Specs opt into the GitHub-backed (real) lane via `// @lane: real`.
// Anything else — present + `local`, missing entirely, or present
// with an unrecognised value — falls back to `local`. Local is the
// hermetic default that keeps the standard PR matrix safe.
//
// The parser reads the head ~500 bytes of each spec, so directives
// must live near the top of the file (above the first import).

test.describe("@lane: directive parser", () => {
  function writeFixture(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "select-lane-"));
    const file = path.join(dir, "fixture.spec.js");
    fs.writeFileSync(file, contents);
    return { dir, file };
  }

  test("present + local → returns 'local'", () => {
    const { dir, file } = writeFixture(
      [
        "// @lane: local",
        "const { test } = require('./base');",
        "test('noop', () => {});",
        "",
      ].join("\n"),
    );
    try {
      expect(parseSpecDirectives(file).lane).toBe("local");
      expect(parseLaneDirective(file)).toBe("local");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present + real → returns 'real'", () => {
    const { dir, file } = writeFixture(
      ["// @lane: real", "const { test } = require('./base');", "test('noop', () => {});", ""].join(
        "\n",
      ),
    );
    try {
      expect(parseSpecDirectives(file).lane).toBe("real");
      expect(parseLaneDirective(file)).toBe("real");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present + invalid value → rejects, treats as local", () => {
    const { dir, file } = writeFixture(
      [
        "// @lane: bogus",
        "const { test } = require('./base');",
        "test('noop', () => {});",
        "",
      ].join("\n"),
    );
    try {
      // parseSpecDirectives drops the unknown value silently —
      // d.lane stays undefined.
      expect(parseSpecDirectives(file).lane).toBeUndefined();
      // parseLaneDirective resolves the absence to the local default.
      expect(parseLaneDirective(file)).toBe("local");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent → defaults to 'local'", () => {
    const { dir, file } = writeFixture(
      ["const { test } = require('./base');", "test('noop', () => {});", ""].join("\n"),
    );
    try {
      expect(parseSpecDirectives(file).lane).toBeUndefined();
      expect(parseLaneDirective(file)).toBe("local");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trailing rationale comment after value → still parses", () => {
    // The convention is to leave a one-line explanation beside each
    // annotation, e.g. `// @lane: real — needs prod GET`. The parser
    // must split on the rationale separator so the value stays
    // recognisable.
    const { dir, file } = writeFixture(
      [
        "// @lane: real — needs prod byte-parity probe",
        "const { test } = require('./base');",
        "test('noop', () => {});",
        "",
      ].join("\n"),
    );
    try {
      expect(parseLaneDirective(file)).toBe("real");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directive inside a JSDoc-style block comment → still parses", () => {
    const { dir, file } = writeFixture(
      ["/*", " * Block-comment header.", " * @lane: real", " */", "const x = 1;", ""].join("\n"),
    );
    try {
      expect(parseLaneDirective(file)).toBe("real");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── filterByLane helper ─────────────────────────────────────────────
//
// Given a list of repo-root-relative spec paths, returns the subset
// whose `@lane:` directive matches the requested lane. Specs without
// an annotation default to `local`.

test.describe("filterByLane", () => {
  function buildFixtureTree(entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "select-lane-tree-"));
    const e2e = path.join(dir, "e2e");
    fs.mkdirSync(e2e, { recursive: true });
    for (const [name, header] of Object.entries(entries)) {
      fs.writeFileSync(
        path.join(e2e, name),
        [header || "", "test('noop', () => {});", ""].join("\n"),
      );
    }
    return dir;
  }

  test("filterByLane(specs, 'real') returns only @lane: real specs", () => {
    const repoRoot = buildFixtureTree({
      "alpha.spec.js": "// @lane: real",
      "beta.spec.js": "// @lane: local",
      "gamma.spec.js": "// no annotation - defaults to local",
      "delta.spec.js": "// @lane: real — needs prod",
    });
    try {
      const specs = [
        "e2e/alpha.spec.js",
        "e2e/beta.spec.js",
        "e2e/gamma.spec.js",
        "e2e/delta.spec.js",
      ];
      expect(filterByLane(specs, "real", { repoRoot })).toEqual([
        "e2e/alpha.spec.js",
        "e2e/delta.spec.js",
      ]);
      expect(filterByLane(specs, "local", { repoRoot })).toEqual([
        "e2e/beta.spec.js",
        "e2e/gamma.spec.js",
      ]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("filterByLane defaults unknown lane values to 'local'", () => {
    const repoRoot = buildFixtureTree({
      "alpha.spec.js": "// @lane: real",
      "beta.spec.js": "// @lane: local",
    });
    try {
      const specs = ["e2e/alpha.spec.js", "e2e/beta.spec.js"];
      // 'bogus' is not 'real' → treat as 'local'.
      expect(filterByLane(specs, "bogus", { repoRoot })).toEqual(["e2e/beta.spec.js"]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ── selectSpecs lane integration ───────────────────────────────────
//
// The selector's main flow honours TEST_LANE / options.lane: when
// `real`, only @lane: real specs survive; when `local` (or unset),
// only @lane: local (or unmarked) specs survive.

test.describe("selectSpecs lane integration", () => {
  test("TEST_LANE=real drops all @lane: local specs from a post-change subset", () => {
    // _posts/* selects several local-marked specs (cms-smoke,
    // cms-editorial-workflow, blog-post, visual-regression). None
    // are @lane: real, so the subset collapses to skip.
    const r = selectSpecs(["_posts/2026-04-25-something.md"], {
      lane: "real",
    });
    expect(r.scope).toBe("skip");
  });

  test("TEST_LANE=real on an admin/ change keeps real-lane specs", () => {
    // admin/ selects admin-bundle-parity (real) + many local specs.
    // Only the real-marked ones should survive.
    const r = selectSpecs(["admin/index.html"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/admin-bundle-parity.spec.js");
    // Local-only specs must be filtered out.
    expect(r.files).not.toContain("e2e/cms-smoke.spec.js");
    expect(r.files).not.toContain("e2e/admin-reviews-stats.spec.js");
  });

  test("TEST_LANE=local (default) preserves existing behaviour", () => {
    // No `lane` option, no env var — the default path should match
    // what the existing select-specs.test.js fixtures already assert.
    const prev = process.env.TEST_LANE;
    try {
      delete process.env.TEST_LANE;
      const r = selectSpecs(["_posts/2026-04-25-something.md"]);
      expect(r.scope).toBe("subset");
      expect(r.files).toContain("e2e/cms-smoke.spec.js");
      expect(r.files).toContain("e2e/blog-post.spec.js");
      // Real-lane-only specs must NOT be in a default-lane subset.
      expect(r.files).not.toContain("e2e/admin-bundle-parity.spec.js");
    } finally {
      if (prev === undefined) delete process.env.TEST_LANE;
      else process.env.TEST_LANE = prev;
    }
  });

  test("TEST_LANE=real on a fanout converts scope=all to a real-only subset", () => {
    // _layouts/* would normally fanout to scope=all. With lane=real
    // we can't accept that — `all` runs every spec including locals.
    const r = selectSpecs(["_layouts/post.html"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/admin-bundle-parity.spec.js");
    expect(r.files).not.toContain("e2e/cms-smoke.spec.js");
  });
});
