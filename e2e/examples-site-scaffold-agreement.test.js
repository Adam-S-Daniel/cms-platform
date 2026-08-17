// @lane: local — the END-TO-END proof behind examples-site-pins-current.test.js.
// Hermetic: synthetic trees under os.tmpdir(), no Jekyll, no browser, NO
// NETWORK. It does spawn `bash scripts/verify-consumer-pins.sh` and `node` on
// those trees, exactly as check-platform-pin-consistency.test.js already does
// in this same lane — that is the point of the file, and the reason it is a
// SEPARATE spec from the pure-fs guard it backs.
//
// ── THE INVARIANT ─────────────────────────────────────────────────────────
//   A drift shape that would red a SCAFFOLDED SITE's own consumer gate must red
//   the TEMPLATE GUARD first.
//
// One direction, deliberately. The guard is allowed to be STRICTER — a template
// `uses:@v0.1.1` reds it while the scaffolded site is clean, because
// substitute() normalises the pin on the way out; that asymmetry is the whole
// point of guarding the template a human hand-copies from (docs/SYNC.md). What
// must never happen is the other direction: guard green, new site born failing
// its own gate.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// It has happened twice. Round 1 shipped a parse-only guard that missed a
// COMPOSITE's trailing `# vX.Y.Z` comment; round 2 closed that one and missed
// the identical shape on a REUSABLE and on a `platform_ref:` line — measured on
// the pristine branch at 80d77b9: template guard exit 0, scaffolded site's
// verify-consumer-pins.sh exit 1, on a ONE-LINE template edit. Each round's
// header then presented its own gap list as complete. A prose claim about
// coverage is what failed both times, so the coverage claim now has to survive
// an executed table.
//
// The structural half of the fix (one shared rule module, `require`d by the
// guard and shelled out to by the consumer gate — see e2e/template-pin-rules.js)
// makes the two hard to split. This makes it hard to split SILENTLY: add a
// shape here whenever one is found, and a guard that stops seeing it goes red.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { offences } = require("./template-pin-rules");
const { substitute } = require("../scaffold/create-site.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_WORKFLOWS = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const VERIFIER = path.join(REPO_ROOT, "scripts", "verify-consumer-pins.sh");
const PLATFORM_SCRIPTS = [
  "verify-consumer-pins.sh",
  "check-platform-pin-consistency.js",
  "stale-platform-refs.js",
];
const SLUG = "Adam-S-Daniel/cms-platform";
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"));
const CANONICAL = `v${MANIFEST.version}`;

const templateFiles = () =>
  fs
    .readdirSync(TEMPLATE_WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

// A job with `steps:` — no template caller has one today, so the shapes that
// need a step (a composite ref, a `run:` line) have to add it.
const stepJob = (step) => `\n  site-local:\n    runs-on: ubuntu-latest\n    steps:\n${step}\n`;

// ── the drift shapes ─────────────────────────────────────────────────────
// `guard` / `site` are the EXPECTED exit-ish verdicts, asserted individually so
// a change that flips either direction is named, not just counted. `site` is
// the scaffolded consumer's verify-consumer-pins.sh exit code.
const SHAPES = [
  {
    name: "pristine template",
    file: null,
    mutate: (t) => t,
    guard: "green",
    site: 0,
  },
  {
    name: "stale trailing # comment on a platform REUSABLE",
    file: "deploy-production.yml",
    mutate: (t) =>
      t.replace(
        `${SLUG}/.github/workflows/deploy-production.yml@${CANONICAL}`,
        `${SLUG}/.github/workflows/deploy-production.yml@${CANONICAL}  # v0.1.1 (2026-01-01)`,
      ),
    guard: "red",
    site: 1,
  },
  {
    name: "stale trailing # comment on a platform_ref: line",
    file: "e2e-tests.yml",
    mutate: (t) =>
      t.replace(`platform_ref: ${CANONICAL}`, `platform_ref: ${CANONICAL}  # was v0.1.1`),
    guard: "red",
    site: 1,
  },
  {
    name: "SHA-pinned REUSABLE with a CURRENT comment (still a violation)",
    file: "deploy-production.yml",
    mutate: (t) =>
      t.replace(
        `deploy-production.yml@${CANONICAL}`,
        `deploy-production.yml@${"2".repeat(40)}  # ${CANONICAL} (2026-08-17)`,
      ),
    guard: "red",
    site: 1,
  },
  {
    name: "platform REUSABLE pinned to a branch (@main — no version token at all)",
    file: "deploy-production.yml",
    mutate: (t) => t.replace(`deploy-production.yml@${CANONICAL}`, "deploy-production.yml@main"),
    guard: "red",
    site: 1,
  },
  {
    name: "COMPOSITE pinned by SHA with a stale comment",
    file: "deploy-production.yml",
    mutate: (t) =>
      t +
      stepJob(
        `      - uses: ${SLUG}/.github/actions/recursion-gate@${"1".repeat(40)}` +
          "  # v0.1.1 (2026-01-01)",
      ),
    guard: "red",
    site: 1,
  },
  {
    name: "COMPOSITE pinned by SHA with a CURRENT comment (house style — must PASS)",
    file: "deploy-production.yml",
    mutate: (t) =>
      t +
      stepJob(
        `      - uses: ${SLUG}/.github/actions/recursion-gate@${"1".repeat(40)}` +
          `  # ${CANONICAL} (2026-08-17)`,
      ),
    guard: "green",
    site: 0,
  },
  {
    name: "COMPOSITE with NO version comment at all",
    file: "deploy-production.yml",
    mutate: (t) =>
      t + stepJob(`      - uses: ${SLUG}/.github/actions/recursion-gate@${"1".repeat(40)}`),
    guard: "red",
    site: 1,
  },
  {
    name: "drifted uses:@ref (guard STRICTER — substitute() heals it on the way out)",
    file: "deploy-production.yml",
    mutate: (t) => t.replace(`deploy-production.yml@${CANONICAL}`, "deploy-production.yml@v0.1.1"),
    guard: "red",
    site: 0,
  },
  {
    name: "drifted with: platform_ref: (guard STRICTER — likewise healed)",
    file: "canary-prod.yml",
    mutate: (t) => t.replace(`platform_ref: ${CANONICAL}`, "platform_ref: v0.1.7"),
    guard: "red",
    site: 0,
  },
  {
    // GitHub resolves a lowercase owner; every case-sensitive tool downstream
    // then stops version-checking the ref. substitute()'s anchor is
    // case-INsensitive on purpose, so the SITE is still clean — which is
    // precisely why the guard has to be the one that refuses it.
    name: "MIS-CASED platform slug at a stale semver (guard STRICTER)",
    file: "deploy-production.yml",
    mutate: (t) =>
      `${t}\n  site-local2:\n    uses: adam-s-daniel/cms-platform` +
      "/.github/workflows/e2e-tests.yml@v0.1.1\n",
    guard: "red",
    site: 0,
  },
  {
    name: "MIS-CASED platform slug at @main (no version token to catch it by)",
    file: "deploy-production.yml",
    mutate: (t) =>
      `${t}\n  site-local2:\n    uses: adam-s-daniel/cms-platform` +
      "/.github/workflows/e2e-tests.yml@main\n",
    guard: "red",
    site: 0,
  },
];

// A synthetic platform tree: the REAL scripts + the (possibly mutated) template
// as the canonical workflow set + the harness's own `yaml` symlinked in, so the
// whole thing stays offline.
function mkPlatform(workflows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-agree-plat-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const s of PLATFORM_SCRIPTS) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", s), path.join(dir, "scripts", s));
  }
  const canon = path.join(dir, "examples", "site", ".github", "workflows");
  fs.mkdirSync(canon, { recursive: true });
  for (const [name, text] of Object.entries(workflows)) {
    fs.writeFileSync(path.join(canon, name), text);
  }
  fs.mkdirSync(path.join(dir, "e2e", "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.resolve(__dirname, "node_modules", "yaml"),
    path.join(dir, "e2e", "node_modules", "yaml"),
    "dir",
  );
  return dir;
}

// What `scaffold/create-site.js` writes into a new site's .github/workflows —
// the REAL transform, at the default domain so only the pin rules move.
//
// It also seeds the preview-media probe sentinel, because the consumer gate
// checks for it (#84) and its absence is a FAIL unrelated to pins — a synthetic
// site without it would make every case below red for the wrong reason. Bytes
// come from the harness fixture, the same source create-site.js seeds from.
function mkScaffoldedConsumer(workflows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-agree-site-"));
  fs.writeFileSync(
    path.join(root, "platform.lock"),
    `platform_repo: ${SLUG}\nplatform_ref: ${CANONICAL}\n`,
  );
  const sentinel = path.join(root, "assets", "images", "uploads", "e2e-preview-media-probe.png");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures", "tiny-pixel.png"), sentinel);
  const wf = path.join(root, ".github", "workflows");
  fs.mkdirSync(wf, { recursive: true });
  for (const [name, text] of Object.entries(workflows)) {
    fs.writeFileSync(
      path.join(wf, name),
      substitute(text, {
        prefix: "example-com",
        domain: "example.com",
        platformVersion: CANONICAL,
      }),
    );
  }
  return root;
}

function applyShape(shape) {
  const workflows = {};
  for (const f of templateFiles()) {
    const text = fs.readFileSync(path.join(TEMPLATE_WORKFLOWS, f), "utf8");
    workflows[f] = shape.file === f ? shape.mutate(text) : text;
  }
  if (shape.file) {
    const before = fs.readFileSync(path.join(TEMPLATE_WORKFLOWS, shape.file), "utf8");
    // A mutation that silently no-ops (the template moved under it) would make
    // its case a duplicate of "pristine" and pass for the wrong reason.
    if (workflows[shape.file] === before) {
      throw new Error(`shape "${shape.name}" did not change ${shape.file} — mutation is stale`);
    }
  }
  return workflows;
}

// The TEMPLATE-GUARD verdict for a shape: the same rule set
// examples-site-pins-current.test.js applies, over the same files.
function guardVerdict(workflows) {
  const found = [];
  for (const [file, text] of Object.entries(workflows)) {
    for (const o of offences(text, { canonical: CANONICAL, file })) {
      found.push(`${file} line ${o.line}: ${o.found}`);
    }
  }
  return { verdict: found.length ? "red" : "green", found };
}

// The SCAFFOLDED SITE's own verdict: the real shell gate, real exit code.
function siteVerdict(workflows) {
  const platform = mkPlatform(workflows);
  const site = mkScaffoldedConsumer(workflows);
  const res = spawnSync("bash", [VERIFIER, "--platform-dir", platform], {
    cwd: site,
    encoding: "utf8",
  });
  return { exit: res.status, out: `${res.stdout}${res.stderr}` };
}

test.describe("scaffold-template guard AGREES with the scaffolded site's own pin gate", () => {
  test("the verifier and the shared scanner are both present to be driven", () => {
    for (const s of PLATFORM_SCRIPTS) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, "scripts", s)),
        `scripts/${s} is missing — verify-consumer-pins.sh hard-FAILs without it, which would ` +
          `turn every case below into a meaningless red. If it moved, move it here too.`,
      ).toBe(true);
    }
  });

  for (const shape of SHAPES) {
    test(`${shape.name} → guard ${shape.guard}, site gate ${shape.site}`, () => {
      const workflows = applyShape(shape);
      const guard = guardVerdict(workflows);
      const site = siteVerdict(workflows);

      expect(
        guard.verdict,
        `TEMPLATE GUARD verdict for "${shape.name}" changed.\nfindings:\n  ` +
          `${guard.found.join("\n  ") || "(none)"}`,
      ).toBe(shape.guard);

      expect(
        site.exit,
        `SCAFFOLDED SITE gate verdict for "${shape.name}" changed:\n${site.out}`,
      ).toBe(shape.site);

      // THE INVARIANT. Stated separately from the two per-shape expectations
      // above so that if someone relaxes one of them, this still names what
      // actually broke.
      if (site.exit !== 0) {
        expect(
          guard.verdict,
          `SPLIT — the shape "${shape.name}" reds a scaffolded site's own ` +
            `scripts/verify-consumer-pins.sh (exit ${site.exit}) while the TEMPLATE GUARD is ` +
            `green. That is the exact failure this file exists to prevent: the platform PR that ` +
            `introduces the drift passes, and the next site scaffolded off this template is BORN ` +
            `failing its own pin gate.\nsite gate said:\n${site.out}\n` +
            `Close it in e2e/template-pin-rules.js — and prefer widening one of the two rules ` +
            `there over adding a third: an enumeration of spellings is what lost twice already.`,
        ).toBe("red");
      }
    });
  }
});
