// @lane: local — pure-Node unit tests for scripts/rewrite-platform-pins.js
//
// WHY THIS EXISTS (#530). platform-bump.yml moved a consumer's pins with a
// global `perl s/CUR/LATEST/g` over each pin-bearing file, so prose naming the
// current version moved too: jodidaniel/jodidaniel.com#303 turned
//     # since v0.1.123 — the CMS_PLATFORM_PAT fallback is gone.
// into "since v0.1.124", and every bump since v0.1.103 had re-dated it. The
// rewrite is now a script that moves only what check-platform-pin-consistency.js
// reads as a pin.
//
// The fixture puts every real pin shape beside decoys carrying the SAME version
// string — comments, a trailing comment on a pin line, quoted strings, a `run:`
// block, an input default, a `uses:` to a different repo at the same tag, a
// second Gemfile.lock GIT block, a docs file — and asserts the result is
// byte-for-byte the fixture with only the pins changed.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { scanStalePlatformRefs } = require("../scripts/stale-platform-refs.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const REWRITE = path.join(REPO_ROOT, "scripts", "rewrite-platform-pins.js");
const CHECKER = path.join(REPO_ROOT, "scripts", "check-platform-pin-consistency.js");
const SENTINEL_REL = "assets/images/uploads/e2e-preview-media-probe.png";
const SENTINEL_SRC = path.join(__dirname, "fixtures", "tiny-pixel.png");
const SLUG = "Adam-S-Daniel/cms-platform";
const OLD = "v0.1.123";
const NEW = "v0.1.124";
const OLD_SHA = "1".repeat(40);
const NEW_SHA = "2".repeat(40);
const OTHER_SHA = "3".repeat(40);

// Each builder takes the version (and commit) the REAL pins should carry. Every
// literal `${OLD}` below is a decoy: it must read `v0.1.123` after the bump.
const caller = (pin) => `# The push credential, and the ONLY one since ${OLD}: the CMS automation
# App's private key.
# since ${OLD} — the CMS_PLATFORM_PAT fallback is gone.
name: "Deploy (since ${OLD})"
on:
  workflow_dispatch:
    inputs:
      note:
        default: ${OLD}
permissions:
  contents: read
jobs:
  deploy:
    uses: ${SLUG}/.github/workflows/deploy-production.yml@${pin} # moved here in ${OLD}
    with:
      apex_domain: example.com
      some_input: ${OLD}
      # Uncomment BOTH lines together.
      # media_archive_bucket: example-com-media-archive
      # platform_ref: ${pin}
      platform_ref: '${pin}'
  other:
    uses: other-org/other-repo/.github/workflows/deploy-production.yml@${OLD}
    with:
      platform_ref: \${{ github.sha }}
  build:
    runs-on: ubuntu-latest
    env:
      NOTE: "upgraded from ${OLD}"
    steps:
      - uses: ${SLUG}/.github/actions/install-playwright-browsers@${pin}
      - uses: other-org/other-repo/.github/actions/setup@${OLD}
      - { uses: "${SLUG}/.github/actions/flow-step@${pin}" }
      - run: |
          # uses: ${SLUG}/.github/workflows/x.yml@${OLD}
          echo "platform_ref: ${OLD}"
`;

// A site-authored workflow with no pin at all, only prose.
const siteNotes = () => `# Added in ${OLD}; see docs/NOTES.md.
name: Site notes
on: workflow_dispatch
jobs:
  notes:
    runs-on: ubuntu-latest
    steps:
      - run: echo "site notes since ${OLD}"
`;

const platformLock = (pin) => `# Bumped from ${OLD} by platform-bump.
platform_repo: ${SLUG}
platform_ref: ${pin}
`;

const gemfile = (pin) => `source "https://rubygems.org"
# Theme pinned since ${OLD} (see docs).
gem "jekyll", "~> 4.3"
gem "cms-platform-theme", git: "https://github.com/${SLUG}", glob: "theme/*.gemspec", tag: "${pin}"
gem "other-theme", git: "https://github.com/other-org/other-theme", tag: "${OLD}"
`;

const gemfileLock = (pin, sha) => `GIT
  remote: https://github.com/${SLUG}
  revision: ${sha}
  tag: ${pin}
  glob: theme/*.gemspec
  specs:
    cms-platform-theme (0.1.4)

GIT
  remote: https://github.com/other-org/other-theme
  revision: ${OTHER_SHA}
  tag: ${OLD}
  specs:
    other-theme (0.1.123)

DEPENDENCIES
  cms-platform-theme!
  other-theme!
`;

const notes = () => `# Notes\n\nThe PAT fallback has been gone since ${OLD}; platform_ref: ${OLD} was the last with it.\n`;

// rel path -> contents, for a tree whose pins sit at `pin` / `sha`.
function tree(pin, sha) {
  return {
    "platform.lock": platformLock(pin),
    Gemfile: gemfile(pin),
    "Gemfile.lock": gemfileLock(pin, sha),
    ".github/workflows/caller.yml": caller(pin),
    ".github/workflows/site-notes.yml": siteNotes(),
    "docs/NOTES.md": notes(),
  };
}
// Real pins in tree(): five in caller.yml (the reusable, the commented-out
// platform_ref, the quoted platform_ref, two composites) + platform.lock +
// Gemfile + Gemfile.lock's tag.
const PIN_COUNT = 8;

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function materialize(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-pin-rewrite-"));
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

function snapshot(root, rels) {
  return Object.fromEntries(rels.map((rel) => [rel, fs.readFileSync(path.join(root, rel), "utf8")]));
}

function rewrite(root, extra = []) {
  return spawnSync(
    process.execPath,
    [REWRITE, "--root", root, "--slug", SLUG, "--from", OLD, "--to", NEW, "--new-sha", NEW_SHA, ...extra],
    { encoding: "utf8" },
  );
}

function checker(root, canon) {
  return spawnSync(
    process.execPath,
    [CHECKER, "--root", root, "--canonical-workflows", canon, "--require-canonical"],
    { encoding: "utf8" },
  );
}

const out = (r) => `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

test.describe("rewrite-platform-pins.js — only pins move (#530)", () => {
  test("every pin moves and every decoy stays, byte-for-byte", () => {
    const before = tree(OLD, OLD_SHA);
    const root = materialize(before);
    const r = rewrite(root);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain(`SUMMARY: moved ${PIN_COUNT} pin(s) in 4 file(s) from ${OLD} to ${NEW}`);

    const want = tree(NEW, NEW_SHA);
    const got = snapshot(root, Object.keys(want));
    for (const rel of Object.keys(want)) {
      expect(got[rel], `${rel} must equal the fixture with only its pins moved`).toBe(want[rel]);
    }
    // The decoys really are there, at the OLD version, after the bump.
    expect(got[".github/workflows/caller.yml"]).toContain(`# since ${OLD} — the CMS_PLATFORM_PAT fallback is gone.`);
    expect(got[".github/workflows/caller.yml"]).toContain(`other-org/other-repo/.github/workflows/deploy-production.yml@${OLD}`);
    expect(got["Gemfile.lock"]).toContain(`revision: ${OTHER_SHA}\n  tag: ${OLD}`);
    expect(got["docs/NOTES.md"]).toBe(before["docs/NOTES.md"]);
  });

  test("a second run is a no-op", () => {
    const root = materialize(tree(OLD, OLD_SHA));
    expect(rewrite(root).status).toBe(0);
    const once = snapshot(root, Object.keys(tree(NEW, NEW_SHA)));
    const again = rewrite(root);
    expect(again.status, out(again)).toBe(0);
    expect(again.stdout).toContain(`SUMMARY: moved 0 pin(s) in 0 file(s)`);
    expect(again.stdout).not.toMatch(/^REWROTE/m);
    expect(snapshot(root, Object.keys(once))).toEqual(once);
  });

  test("the result passes check-platform-pin-consistency.js --require-canonical", () => {
    const root = materialize(tree(OLD, OLD_SHA));
    write(root, SENTINEL_REL, fs.readFileSync(SENTINEL_SRC));
    // The canonical set at the NEW ref: the same two callers, at NEW.
    const want = tree(NEW, NEW_SHA);
    const canon = materialize({
      "caller.yml": want[".github/workflows/caller.yml"],
      "site-notes.yml": want[".github/workflows/site-notes.yml"],
    });
    const r = rewrite(root);
    expect(r.status, out(r)).toBe(0);
    const c = checker(root, canon);
    expect(c.status, out(c)).toBe(0);
    expect(c.stdout).toContain(`pass for platform_ref ${NEW}`);
    expect(c.stdout).toContain("Pins are consistent.");
  });

  test("one file it cannot rewrite safely means NOTHING is written", () => {
    const files = tree(OLD, OLD_SHA);
    files[".github/workflows/broken.yml"] = `jobs:\n  x:\n    uses: ${SLUG}/.github/workflows/x.yml@${OLD}\n  - [unclosed\n`;
    const root = materialize(files);
    const r = rewrite(root);
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/^ERROR \.github\/workflows\/broken\.yml: does not parse as YAML/m);
    expect(r.stdout).toContain("NOTHING was written");
    expect(snapshot(root, Object.keys(files))).toEqual(files);
  });

  test("refs and the commit are validated before they reach a consumer's file", () => {
    const root = materialize(tree(OLD, OLD_SHA));
    for (const extra of [["--to", 'v1"\n#'], ["--new-sha", "not-a-sha"], ["--slug", "no-slash"]]) {
      const r = spawnSync(
        process.execPath,
        [REWRITE, "--root", root, "--from", OLD, "--to", NEW, ...extra],
        { encoding: "utf8" },
      );
      expect(r.status, `${extra.join(" ")}\n${out(r)}`).toBe(2);
    }
    expect(snapshot(root, ["platform.lock"])["platform.lock"]).toBe(platformLock(OLD));
  });
});

test.describe("rewrite-platform-pins.js — edge cases the main fixture cannot reach", () => {
  const run = (root, from, to, extra = []) =>
    spawnSync(process.execPath, [REWRITE, "--root", root, "--slug", SLUG, "--from", from, "--to", to, ...extra], {
      encoding: "utf8",
    });

  test("a version that changes LENGTH moves every pin (offsets shift, so edits apply back to front)", () => {
    const from = "v0.1.99";
    const to = "v0.1.100";
    const wf = (v) => `name: Lengths
jobs:
  a:
    uses: ${SLUG}/.github/workflows/a.yml@${v}
    with:
      platform_ref: ${v}
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: ${SLUG}/.github/actions/one@${v}
      - uses: ${SLUG}/.github/actions/two@${v}
      # platform_ref: ${v}
`;
    const lock = (v) => `platform_repo: ${SLUG}\nplatform_ref: ${v}\n`;
    const gem = (v) => `gem "cms-platform-theme", git: "https://github.com/${SLUG}", tag: "${v}"\n`;
    const glock = (v, sha) =>
      `GIT\n  remote: https://github.com/${SLUG}\n  revision: ${sha}\n  tag: ${v}\n  specs:\n    cms-platform-theme (0.1.4)\n`;
    const root = materialize({
      ".github/workflows/lengths.yml": wf(from),
      "platform.lock": lock(from),
      Gemfile: gem(from),
      "Gemfile.lock": glock(from, OLD_SHA),
    });
    const r = run(root, from, to, ["--new-sha", NEW_SHA]);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain(`SUMMARY: moved 8 pin(s) in 4 file(s) from ${from} to ${to}`);
    expect(snapshot(root, [".github/workflows/lengths.yml", "platform.lock", "Gemfile", "Gemfile.lock"])).toEqual({
      ".github/workflows/lengths.yml": wf(to),
      "platform.lock": lock(to),
      Gemfile: gem(to),
      "Gemfile.lock": glock(to, NEW_SHA),
    });
  });

  test("a `uses:` from another owner never moves, even when its owner/repo is as long as the slug", () => {
    // Same length as the slug, and one character past it the path reads
    // `.github/workflows/...`; a prefix check is the only thing keeping it out.
    const sameLength = `Adam-S-Daniel/cms-platfora`;
    expect(sameLength.length).toBe(SLUG.length);
    const wf = (v) => `jobs:
  real:
    uses: ${SLUG}/.github/workflows/x.yml@${v}
  lookalike:
    uses: ${sameLength}/.github/workflows/x.yml@${OLD}
  longer:
    uses: ${SLUG}-extra/.github/workflows/x.yml@${OLD}
  composites:
    runs-on: ubuntu-latest
    steps:
      - uses: ${sameLength}/.github/actions/y@${OLD}
      - uses: ${SLUG}-extra/.github/actions/y@${OLD}
`;
    const root = materialize({ ".github/workflows/decoys.yml": wf(OLD) });
    const r = rewrite(root);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain(`SUMMARY: moved 1 pin(s) in 1 file(s)`);
    expect(snapshot(root, [".github/workflows/decoys.yml"])[".github/workflows/decoys.yml"]).toBe(wf(NEW));
  });

  test("a cms-platform-theme gem from another source never moves", () => {
    const gem = (v) => `source "https://rubygems.org"
gem "cms-platform-theme", git: "https://github.com/example-org/cms-platform-theme", tag: "${OLD}"
gem "cms-platform-theme", git: "https://github.com/${SLUG}", tag: "${v}"
`;
    const root = materialize({ Gemfile: gem(OLD) });
    const r = rewrite(root);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain(`SUMMARY: moved 1 pin(s) in 1 file(s)`);
    expect(snapshot(root, ["Gemfile"]).Gemfile).toBe(gem(NEW));
  });

  test("a --to that would re-type a plain `platform_ref:` value is refused and nothing is written", () => {
    // `platform_ref: v0.1.123` -> `platform_ref: 1.5` would turn the string into
    // a YAML float, so the pin would vanish from every reader; the re-parse
    // check catches it where the splice itself looks fine.
    const files = {
      "platform.lock": `platform_repo: ${SLUG}\nplatform_ref: ${OLD}\n`,
      ".github/workflows/c.yml": `jobs:\n  d:\n    uses: ${SLUG}/.github/workflows/x.yml@${OLD}\n    with:\n      platform_ref: ${OLD}\n`,
    };
    const root = materialize(files);
    const r = run(root, OLD, "1.5");
    expect(r.status, out(r)).toBe(1);
    expect(r.stdout).toMatch(/does not re-parse to the expected pins/);
    expect(snapshot(root, Object.keys(files))).toEqual(files);
  });
});

test.describe("rewrite-platform-pins.js — against the platform's own examples/site", () => {
  // The template every site is scaffolded from, at the current release, bumped
  // to a made-up next one. Both of a consumer's bump gates must pass on the
  // result: the stale-ref scan (verify-consumer-pins.sh's step 2, which also
  // reads the commented-out `# platform_ref:` opt-in line) and the checker.
  const version = `v${JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8")).version}`;
  const next = version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  const canonical = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");

  test("only pin lines change, and both bump gates pass", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-pin-rewrite-site-"));
    fs.cpSync(path.join(REPO_ROOT, "examples", "site", ".github"), path.join(root, ".github"), { recursive: true });
    write(root, "platform.lock", `platform_repo: ${SLUG}\nplatform_ref: ${version}\n`);
    write(root, SENTINEL_REL, fs.readFileSync(SENTINEL_SRC));
    const rels = fs.readdirSync(path.join(root, ".github", "workflows")).map((n) => `.github/workflows/${n}`);
    const before = snapshot(root, ["platform.lock", ...rels]);

    const r = spawnSync(process.execPath, [REWRITE, "--root", root, "--from", version, "--to", next], {
      encoding: "utf8",
    });
    expect(r.status, out(r)).toBe(0);
    const moved = Number((r.stdout.match(/SUMMARY: moved (\d+) pin/) || [])[1]);
    expect(moved, out(r)).toBeGreaterThan(0);

    // Every changed line differs ONLY by the version token, and there is
    // exactly one changed line per moved pin.
    const after = snapshot(root, Object.keys(before));
    let changedLines = 0;
    for (const rel of Object.keys(before)) {
      const a = before[rel].split("\n");
      const b = after[rel].split("\n");
      expect(b.length, rel).toBe(a.length);
      a.forEach((line, i) => {
        if (line === b[i]) return;
        changedLines += 1;
        expect(b[i], `${rel}:${i + 1}`).toBe(line.split(version).join(next));
      });
    }
    expect(changedLines).toBe(moved);
    const dormant = after[".github/workflows/deploy-production.yml"];
    if (before[".github/workflows/deploy-production.yml"].includes(`# platform_ref: ${version}`)) {
      expect(dormant, "the commented-out opt-in pin moves with the live one").toContain(`# platform_ref: ${next}`);
    }

    const stale = Object.entries(after).flatMap(([rel, text]) =>
      scanStalePlatformRefs(text, { ref: next, slug: SLUG, file: rel }),
    );
    expect(stale, "verify-consumer-pins.sh step 2 must find no stale platform ref").toEqual([]);
    const c = checker(root, canonical);
    expect(c.status, out(c)).toBe(0);
  });
});

test.describe("platform-bump.yml — runs the rewrite (#530)", () => {
  // EXECUTES the bump step's rewrite block, lifted out of the run script, in a
  // scratch consumer with stub `gh` (serves this checkout's script) and `npm`
  // (the yaml parser comes from e2e/node_modules via NODE_PATH).
  const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
  const run = parseYaml(readWorkflow("platform-bump.yml")).jobs.bump.steps.find((s) => s.id === "bump").run;

  function lockReadBlock() {
    const lines = run.split("\n");
    const latest = lines.findIndex((l) => l.trim() === 'if [ -z "$LATEST" ]; then');
    expect(latest).toBeGreaterThan(-1);
    const start = lines.findIndex((l, i) => i > latest && l.trim() === "fi") + 1;
    const cur = lines.findIndex((l) => l.trim().startsWith("CUR=$(sed"));
    expect(cur).toBeGreaterThanOrEqual(start);
    const end = lines.findIndex((l, i) => i > cur && l.trim() === "fi");
    expect(end).toBeGreaterThan(cur);
    return lines.slice(start, end + 1).join("\n");
  }

  function rewriteBlock() {
    const lines = run.split("\n");
    const start = lines.findIndex((l) => l.trim() === 'if [ -n "$CUR" ]; then');
    expect(start, 'the run script must guard the rewrite with `if [ -n "$CUR" ]`').toBeGreaterThan(-1);
    const indent = lines[start].match(/^\s*/)[0];
    const end = lines.findIndex((l, i) => i > start && l === `${indent}fi`);
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join("\n");
  }

  function runBlock(files, cur, latest = NEW) {
    const root = materialize(files);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cms-pin-rewrite-bin-"));
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash\n[[ "$2" == "repos/${SLUG}/contents/scripts/rewrite-platform-pins.js?ref=${NEW_SHA}" ]] || exit 1\ncat "${REWRITE}"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const res = spawnSync("bash", ["-euo", "pipefail", "-c", rewriteBlock()], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_PATH: path.join(__dirname, "node_modules"),
        RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), "cms-pin-rewrite-tmp-")),
        PLATFORM: SLUG,
        CUR: cur,
        LATEST: latest,
        NEW_SHA,
      },
    });
    return { res, root };
  }

  test("the step moves exactly the pins", () => {
    const { res, root } = runBlock(tree(OLD, OLD_SHA), OLD);
    expect(res.status, out(res)).toBe(0);
    const want = tree(NEW, NEW_SHA);
    expect(snapshot(root, Object.keys(want))).toEqual(want);
  });

  test("a v0.1.125 dev-hooks sync bump preserves its historical credential comment", () => {
    const file = ".github/workflows/dev-hooks-sync.yml";
    const before = `jobs:
  sync:
    uses: ${SLUG}/.github/workflows/dev-hooks-sync.yml@v0.1.125
    with:
      platform_ref: v0.1.125
    secrets:
      # key, with vars.CMS_AUTOMATION_APP_ID set on this repo. The only credential
      # since v0.1.125 — the CMS_PLATFORM_PAT fallback is gone. Without it the PR
      # is opened by GITHUB_TOKEN and fires no CI (a warning, not a failure).
      app_private_key: \${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}
`;
    const want = `jobs:
  sync:
    uses: ${SLUG}/.github/workflows/dev-hooks-sync.yml@v0.1.126
    with:
      platform_ref: v0.1.126
    secrets:
      # key, with vars.CMS_AUTOMATION_APP_ID set on this repo. The only credential
      # since v0.1.125 — the CMS_PLATFORM_PAT fallback is gone. Without it the PR
      # is opened by GITHUB_TOKEN and fires no CI (a warning, not a failure).
      app_private_key: \${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}
`;
    const { res, root } = runBlock({ [file]: before }, "v0.1.125", "v0.1.126");
    expect(res.status, out(res)).toBe(0);
    expect(res.stdout).toContain("SUMMARY: moved 2 pin(s) in 1 file(s) from v0.1.125 to v0.1.126");
    expect(snapshot(root, [file])).toEqual({ [file]: want });
  });

  test("a v0.1.125 platform-bump caller preserves its historical credential comment", () => {
    const file = ".github/workflows/platform-bump.yml";
    const before = `jobs:
  bump:
    uses: ${SLUG}/.github/workflows/platform-bump.yml@v0.1.125
    secrets:
      # The push credential, and the ONLY one since v0.1.125: the CMS automation
      # App's private key.
      app_private_key: \${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}
`;
    const want = `jobs:
  bump:
    uses: ${SLUG}/.github/workflows/platform-bump.yml@v0.1.126
    secrets:
      # The push credential, and the ONLY one since v0.1.125: the CMS automation
      # App's private key.
      app_private_key: \${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}
`;
    const { res, root } = runBlock({ [file]: before }, "v0.1.125", "v0.1.126");
    expect(res.status, out(res)).toBe(0);
    expect(res.stdout).toContain("SUMMARY: moved 1 pin(s) in 1 file(s) from v0.1.125 to v0.1.126");
    expect(snapshot(root, [file])).toEqual({ [file]: want });
  });

  test("a first adoption (no platform.lock, so no $CUR) skips the rewrite instead of failing", () => {
    const files = tree(OLD, OLD_SHA);
    delete files["platform.lock"];
    const { res, root } = runBlock(files, "");
    expect(res.status, out(res)).toBe(0);
    expect(snapshot(root, Object.keys(files))).toEqual(files);
  });

  test("a platform.lock value that is not a bare tag fails with a message naming it", () => {
    // Lifted from the `CUR=$(sed ...)` read through its validation, run in a
    // scratch consumer. A quoted value or a trailing comment fails closed and
    // says what was read, not a usage error from deep in the rewrite.
    const block = lockReadBlock();
    const readCur = (value) => {
      const root = materialize({ "platform.lock": `platform_repo: ${SLUG}\nplatform_ref: ${value}\n` });
      return spawnSync("bash", ["-euo", "pipefail", "-c", `${block}\necho "CUR=$CUR"`], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, LATEST: NEW },
      });
    };
    expect(readCur(OLD).stdout, "a bare tag passes").toContain(`CUR=${OLD}`);
    expect(readCur(NEW).stdout, "already on the latest").toContain(`already on ${NEW}`);
    for (const bad of [`"${OLD}"`, `${OLD} # pinned`]) {
      const res = readCur(bad);
      expect(res.status, out(res)).toBe(1);
      expect(res.stdout).toContain("::error::platform.lock's platform_ref reads as");
      expect(res.stdout).toContain("not a bare release tag");
      expect(res.stdout).toContain(bad);
    }
  });

  for (const pin of [OLD, NEW]) {
    test(`platform.lock CRLF at ${pin}: fails before lock read or already-current return, with LF remediation`, () => {
      const files = tree(pin, OLD_SHA);
      files["platform.lock"] = files["platform.lock"].replace(/\n/g, "\r\n");
      const root = materialize(files);
      try {
        const res = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", lockReadBlock()], {
          cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LATEST: NEW },
        });
        expect(res.status, out(res)).toBe(1);
        expect(res.stdout).toMatch(/::error::.*platform\.lock.*CRLF.*LF/);
        expect(res.stdout).not.toContain("already on");
        expect(snapshot(root, Object.keys(files))).toEqual(files);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  function resolveAndRewrite({ initial = NEW_SHA, type = "commit", dereferenced = NEW_SHA }) {
    const files = tree(OLD, OLD_SHA);
    const root = materialize(files);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cms-pin-sha-"));
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(scratch, "tmp"));
    const log = path.join(scratch, "calls");
    for (const name of ["cat", "mkdir", "rm"]) fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/bash
printf '%s\\0' "$2" >> "$STUB_LOG"
case "$2" in
  "repos/$PLATFORM/git/refs/tags/$LATEST")
    if [[ "$4" == '.object.sha' ]]; then printf '%s' "$INITIAL_SHA"; else printf '%s' "$TAG_TYPE"; fi ;;
  "repos/$PLATFORM/git/tags/"*) printf '%s' "$DEREFERENCED_SHA" ;;
  "repos/$PLATFORM/contents/scripts/rewrite-platform-pins.js?ref="*) cat "$REWRITE_SCRIPT" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const lines = run.split("\n");
    const start = lines.findIndex((l) => l.trim().startsWith("NEW_SHA=$(gh"));
    const rewrite = lines.findIndex((l, i) => i > start && l.trim() === 'if [ -n "$CUR" ]; then');
    const indent = lines[rewrite].match(/^\s*/)[0];
    const end = lines.findIndex((l, i) => i > rewrite && l === `${indent}fi`);
    expect(start).toBeGreaterThan(-1);
    expect(rewrite).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(rewrite);
    try {
      const res = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", lines.slice(start, end + 1).join("\n")], {
        cwd: root, encoding: "utf8",
        env: {
          PATH: bin, HOME: scratch, NODE_PATH: path.join(__dirname, "node_modules"),
          RUNNER_TEMP: path.join(scratch, "tmp"), PLATFORM: SLUG, LATEST: NEW, CUR: OLD,
          INITIAL_SHA: initial, TAG_TYPE: type, DEREFERENCED_SHA: dereferenced,
          STUB_LOG: log, REWRITE_SCRIPT: REWRITE,
        },
      });
      return {
        res,
        calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\0").filter(Boolean) : [],
        before: files,
        after: snapshot(root, Object.keys(files)),
      };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  for (const [label, invalid] of [
    ["uppercase", "A".repeat(40)],
    ["39 characters", "2".repeat(39)],
    ["41 characters", "2".repeat(41)],
    ["nonhex", "g".repeat(40)],
    ["embedded newline", `${"2".repeat(20)}\n${"2".repeat(20)}`],
    ["empty", ""],
  ]) {
    for (const stage of ["initial", "dereferenced"]) {
      test(`${stage} SHA ${label}: rejected before any API fetch using it and no fixture edits`, () => {
        const r = resolveAndRewrite(stage === "initial"
          ? { initial: invalid, type: "tag" }
          : { initial: OLD_SHA, type: "tag", dereferenced: invalid });
        expect(r.res.status, out(r.res)).toBe(1);
        expect(r.res.stdout).toMatch(/::error::.*40 lowercase hexadecimal/);
        expect(r.calls).toEqual(stage === "initial"
          ? [`repos/${SLUG}/git/refs/tags/${NEW}`]
          : [`repos/${SLUG}/git/refs/tags/${NEW}`, `repos/${SLUG}/git/refs/tags/${NEW}`, `repos/${SLUG}/git/tags/${OLD_SHA}`]);
        expect(r.after).toEqual(r.before);
        for (const type of ["commit", "tag"]) {
          const control = resolveAndRewrite({ initial: type === "tag" ? OLD_SHA : NEW_SHA, type });
          expect(control.res.status, out(control.res)).toBe(0);
          expect(control.calls.at(-1)).toBe(`repos/${SLUG}/contents/scripts/rewrite-platform-pins.js?ref=${NEW_SHA}`);
          expect(control.calls).toHaveLength(type === "tag" ? 4 : 3);
          expect(control.after).toEqual(tree(NEW, NEW_SHA));
        }
      });
    }
  }

  test("the yaml install in the rewrite block runs no package scripts", () => {
    expect(rewriteBlock()).toMatch(/npm install --prefix "\$PIN_TOOLS" --no-save --no-package-lock --ignore-scripts yaml@2\.9\.1/);
  });

  test("a rewrite failure fails the step", () => {
    const files = tree(OLD, OLD_SHA);
    files[".github/workflows/broken.yml"] = "jobs: [unclosed\n";
    const { res, root } = runBlock(files, OLD);
    expect(res.status, out(res)).not.toBe(0);
    expect(res.stdout).toMatch(/::error::the pin rewrite could not move every pin/);
    expect(snapshot(root, Object.keys(files))).toEqual(files);
  });
});
