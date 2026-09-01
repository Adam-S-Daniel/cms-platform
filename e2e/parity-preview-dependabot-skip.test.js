// @lane: local — PURE-FS workflow lint (NO Jekyll build, NO browser).
//
// #383 — PARITY-PREVIEW MUST SKIP EXACTLY THE PRs DEPLOY-PREVIEW SKIPS.
//
// ── The incident ───────────────────────────────────────────────────────
// `deploy-preview.yml`'s `deploy-preview` job carries
// `github.actor != 'dependabot[bot]'`: a Dependabot run cannot reach the
// OIDC role secret, and the preview exists for a human reviewer. So a
// Dependabot PR gets NO `preview-pr<N>` host — ever, by design.
//
// `parity-preview.yml` did not know that. `e2e/select-specs.js` classifies
// `Gemfile*` as render-salient (RENDER_FANOUT_PATTERNS — a gem bump can move
// every rendered byte), which is Dependabot's whole beat. So a
// lockfile-only Dependabot PR selected specs, polled `preview-pr<N>` for the
// full ~20 minutes, and then hard-failed — publishing a RED `parity / parity`,
// a REQUIRED context. Measured on adamdaniel.ai#3443: blocked until a human
// re-pushed the branch under their own name, which was the only thing that
// ever cleared it.
//
// ── What this lint locks, and why it reads ONE side to check the OTHER ──
// The bug was not a wrong condition; it was TWO files disagreeing about who
// gets a preview. A lint that hard-coded the bot's name would let the pair
// drift the moment either side changed it, and would go green over the
// disagreement it exists to catch. So the actor clause is EXTRACTED from
// deploy-preview.yml — the file that decides — and every preview-dependent
// step in parity-preview.yml is asserted to carry that exact string. Rename
// the actor there and this fails until parity-preview follows.
//
// It PARSES both files (workflow-yaml-utils → the `yaml` package), never
// line-scans: an `if:` is a data-model value, GitHub has permitted YAML
// anchors in workflows since 2025-09-18, and a folded/aliased condition is
// invisible to a scanner.
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

// The step names in parity-preview.yml's probe job that must not run when
// there is no preview to probe: the bounded wait, and the hard-fail it feeds.
const PREVIEW_DEPENDENT_STEPS = [
  "Wait for the preview surface (bounded)",
  "Require preview (hard-fail if unreachable on a salient PR)",
];

function stepsOf(doc, jobName) {
  const job = doc.jobs && doc.jobs[jobName];
  expect(job, `${jobName} job exists`).toBeTruthy();
  return job.steps || [];
}

// A step's `if:`, with any `${{ … }}` wrapper stripped, so a bare condition
// and a wrapped one compare the same way (GitHub accepts both).
function conditionOf(step) {
  const raw = step && step.if;
  if (raw == null) return null;
  const s = String(raw).trim();
  const m = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  return (m ? m[1] : s).trim();
}

// The actor clause deploy-preview.yml gates its deploy job on — the SOURCE OF
// TRUTH for "who gets a preview". Extracted, never re-typed.
function deployPreviewActorGuard() {
  const doc = parseYaml(readWorkflow("deploy-preview.yml"));
  const cond = conditionOf({ if: doc.jobs["deploy-preview"].if });
  expect(cond, "deploy-preview job carries an `if:`").toBeTruthy();
  const clause = cond.split("&&").map((c) => c.trim()).find((c) => /github\.actor/.test(c));
  expect(
    clause,
    "deploy-preview's `deploy-preview` job must gate on github.actor — that guard is why a " +
      "Dependabot PR has no preview at all, and this whole lint reads it as the source of truth",
  ).toBeTruthy();
  return clause;
}

test.describe("#383 parity-preview mirrors deploy-preview's actor guard", () => {
  test("deploy-preview still gates its deploy job on the actor", () => {
    expect(deployPreviewActorGuard()).toContain("github.actor");
  });

  test("every preview-dependent parity-probe step carries that exact clause", () => {
    const guard = deployPreviewActorGuard();
    const steps = stepsOf(parseYaml(readWorkflow("parity-preview.yml")), "parity-probe");
    for (const name of PREVIEW_DEPENDENT_STEPS) {
      const step = steps.find((s) => s && s.name === name);
      expect(step, `parity-probe step "${name}" exists`).toBeTruthy();
      const cond = conditionOf(step);
      expect(
        cond,
        `parity-probe step "${name}" must be conditional — an unconditional preview wait is ` +
          `the #383 bug`,
      ).toBeTruthy();
      expect(
        cond,
        `parity-probe step "${name}" must carry deploy-preview's own actor guard verbatim ` +
          `(${guard}). Without it, a PR that deploy-preview deliberately skipped is polled for ` +
          `~20 min and then hard-fails the REQUIRED parity / parity context (#383, ` +
          `adamdaniel.ai#3443).`,
      ).toContain(guard);
    }
  });

  test("the skip is ANNOUNCED — a step says why the gate is satisfied", () => {
    const steps = stepsOf(parseYaml(readWorkflow("parity-preview.yml")), "parity-probe");
    // The positive twin of the guard above: `!=` flipped to `==`.
    const positive = deployPreviewActorGuard().replace("!=", "==");
    const announcer = steps.filter((s) => (conditionOf(s) || "").includes(positive));
    expect(
      announcer.length,
      `parity-probe needs a step conditioned on "${positive}" that explains why the gate is ` +
        `satisfied with no preview. A required check that silently reports green is the shape ` +
        `#371 is about — nobody can tell a deliberate skip from a broken publisher.`,
    ).toBeGreaterThan(0);
    const body = announcer.map((s) => String(s.run || "")).join("\n");
    expect(body, "the announcing step emits a ::notice:: naming the reason").toContain("::notice");
    expect(body, "the notice names Dependabot as the reason").toMatch(/[Dd]ependabot/);
  });

  test("the gate job keeps its #285/#289 cancellation-hazard shape", () => {
    // Belt-and-braces next to required-context-cancellable.test.js: this
    // change touches the probe, and the whole point is that the GATE keeps
    // publishing a context that can only be success or failure. A
    // `timeout-minutes` here would let GitHub kill it and report `cancelled`,
    // which no merge mechanism can override.
    const gate = parseYaml(readWorkflow("parity-preview.yml")).jobs.parity;
    expect(gate, "the `parity` gate job exists").toBeTruthy();
    expect(gate["timeout-minutes"], "the parity gate must have NO timeout-minutes").toBeUndefined();
    expect(gate.concurrency, "the parity gate must have NO concurrency group").toBeUndefined();
    expect(String(gate.if || ""), "the parity gate runs always()").toContain("always()");
  });
});
