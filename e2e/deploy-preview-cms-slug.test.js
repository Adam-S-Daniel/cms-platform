const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, allStrings } = require("./workflow-yaml-utils");

// Locks in the per-CMS-slug preview alias structure of
// .github/workflows/deploy-preview.yml — added per the spike at
// docs/preview-pr-ruleset-spike.md. The structural invariant is:
//
//   1. Both `deploy-preview` and `teardown-preview` derive `cms_slug`
//      from `head_ref` via the SAME shared cms-preview-slug.sh
//      (otherwise a cleanup mismatch would orphan S3 files when the slug
//      shape drifts). In the platform's REUSABLE workflow neither job has
//      the helper scripts checked out by default, so EACH job adds a
//      `Checkout platform scripts` step (repository: <platform_repo>,
//      path: .cms-platform) and runs the script from
//      `./.cms-platform/scripts/cms-preview-slug.sh`. The deploy job ALSO
//      checks out the consuming site's own repo (to build Jekyll), so it
//      carries two checkouts; teardown carries one.
//   2. The deploy job syncs the alias prefix `cms-<slug>/` and registers
//      a `preview-cms-<slug>` GitHub Deployment.
//   3. The teardown job removes the alias prefix.
//   4. The CloudFront invalidation step lists both prefixes when the
//      branch is a `cms/<col>/<slug>` branch.
//   5. The PR-comment step surfaces the slug-derived URL as an
//      additional row when applicable.
//
// The workflow-structure invariants are asserted off the parsed
// workflow — job/step shape structurally, and shell/JS shapes against
// the parser's resolved string values; the slug-derivation invariants
// run the real script (which lives at scripts/cms-preview-slug.sh in the
// platform repo and is invoked from .cms-platform/ in the workflow).

const WORKFLOW = path.join(__dirname, "..", ".github", "workflows", "deploy-preview.yml");

const SLUG_SCRIPT = path.join(__dirname, "..", "scripts", "cms-preview-slug.sh");

function workflow() {
  return parseYaml(fs.readFileSync(WORKFLOW, "utf8"));
}

// Every script/expression/JS string the workflow carries, joined. Shell
// and github-script content checks run against this — the tokens that
// actually execute, with YAML comments already dropped.
function workflowStrings() {
  return allStrings(workflow()).join("\n");
}

// Flat list of every step across every job (for structural step lints).
function allSteps() {
  return Object.values(workflow().jobs || {}).flatMap((j) => (j && j.steps) || []);
}

// Run the real shared script the workflow calls. Invoked via `bash` so the
// test doesn't depend on the file's executable bit being preserved.
function slug(branch) {
  return execFileSync("bash", [SLUG_SCRIPT, branch], { encoding: "utf8" });
}

test.describe("deploy-preview workflow: per-CMS-slug preview alias", () => {
  test("both jobs derive cms_slug via the shared cms-preview-slug.sh", () => {
    // Exactly two call sites — one in deploy-preview, one in
    // teardown-preview — so they can never disagree on the slug shape.
    // In the reusable workflow the script is run from the platform
    // checkout under `.cms-platform/`, so the invocation path is
    // `./.cms-platform/scripts/cms-preview-slug.sh`.
    const matches =
      workflowStrings().match(/\.\/\.cms-platform\/scripts\/cms-preview-slug\.sh/g) || [];
    expect(
      matches.length,
      `expected exactly two .cms-platform/scripts/cms-preview-slug.sh call sites (deploy + teardown); found ${matches.length}`,
    ).toBe(2);
  });

  test("both jobs check out the platform scripts so the shared slug script is on disk", () => {
    // The reusable workflow ships no helper scripts in the consuming site
    // repo, so BOTH jobs must add a `Checkout platform scripts` step
    // (repository: <platform_repo>, path: .cms-platform) before they can
    // run cms-preview-slug.sh. Assert one such platform-scripts checkout
    // PER JOB — that's the invariant that guards against a future edit
    // dropping the teardown checkout and breaking the slug computation at
    // PR-close. (The deploy job additionally checks out the site repo to
    // build Jekyll, so its total checkout count is higher; we key on the
    // path:.cms-platform checkouts specifically, not the raw total.)
    for (const job of ["deploy-preview", "teardown-preview"]) {
      const steps = (workflow().jobs[job] || {}).steps || [];
      const platformCheckouts = steps.filter(
        (s) =>
          s &&
          typeof s.uses === "string" &&
          s.uses.startsWith("actions/checkout@") &&
          s.with &&
          s.with.path === ".cms-platform",
      );
      expect(
        platformCheckouts.length,
        `${job} must check out the platform scripts into .cms-platform exactly once so ` +
          `cms-preview-slug.sh is on disk; found ${platformCheckouts.length}`,
      ).toBe(1);
    }
  });

  test("deploy syncs the cms-<slug> S3 prefix", () => {
    expect(workflowStrings(), "missing `s3://${PREVIEW_BUCKET}/cms-${SLUG}/` sync").toMatch(
      /s3:\/\/\$\{PREVIEW_BUCKET\}\/cms-\$\{?SLUG\}?\//,
    );
  });

  test("deploy gates the slug sync on `cms_slug.outputs.slug != ''`", () => {
    // Without this gate, every regular code PR would attempt to sync
    // an empty `cms-/` prefix, which would either no-op-fail (best
    // case) or pollute the bucket (worst).
    const sync = allSteps().find((s) =>
      String((s && s.name) || "").includes("Sync to S3 — per-CMS-slug alias"),
    );
    expect(sync, "missing the `Sync to S3 — per-CMS-slug alias` step").toBeTruthy();
    expect(
      String(sync.if || ""),
      "missing `if: steps.cms_slug.outputs.slug != ''` gate on the cms-slug sync",
    ).toMatch(/steps\.cms_slug\.outputs\.slug\s*!=\s*''/);
  });

  test("deploy registers a `preview-cms-<slug>` GitHub Deployment", () => {
    expect(
      workflowStrings(),
      "missing `environment: \\`preview-cms-${slug}\\`` deployment registration",
    ).toMatch(/environment:\s*`preview-cms-\$\{slug\}`/);
  });

  test("teardown removes the cms-<slug> S3 prefix", () => {
    expect(workflowStrings(), "missing `aws s3 rm s3://${PREVIEW_BUCKET}/cms-${SLUG}/`").toMatch(
      /aws s3 rm "?s3:\/\/\$\{PREVIEW_BUCKET\}\/cms-\$\{SLUG\}\/"?\s+--recursive/,
    );
  });

  test("invalidation step is gated to the cms-<slug> path conditionally", () => {
    // Both deploy + teardown invalidation steps should add the
    // `/cms-${SLUG}/*` path only when SLUG is non-empty. Look for the
    // shared pattern.
    const matches = workflowStrings().match(/PATHS\+=\("\/cms-\$\{SLUG\}\/\*"\)/g) || [];
    expect(
      matches.length,
      "expected both deploy + teardown to conditionally add the cms-slug path to the invalidation batch",
    ).toBe(2);
  });

  test("no `run:` body interpolates the cms_slug output directly", () => {
    // Security regression guard (#259). `SLUG='${{ steps.cms_slug.outputs.slug }}'`
    // is expanded by the Actions runner BEFORE bash sees the line, so a slug
    // containing a single quote closes the literal and the rest of the slug is
    // parsed as shell — `cms/a/'$(id)'` rendered as `SLUG='a-'$(id)''` and RAN
    // `id`. Both jobs hold the live OIDC deploy role by then. The value must
    // reach the script through an `env:` passthrough (the same shape this
    // workflow already uses for HEAD_REF), where the runner never rewrites the
    // command text.
    const offenders = [];
    for (const [jobName, job] of Object.entries(workflow().jobs || {})) {
      for (const step of (job && job.steps) || []) {
        if (typeof (step && step.run) !== "string") continue;
        if (/\$\{\{[^}]*steps\.cms_slug\.outputs\.slug[^}]*\}\}/.test(step.run)) {
          offenders.push(`${jobName} → ${step.name}`);
        }
      }
    }
    expect(
      offenders,
      "steps.cms_slug.outputs.slug must be passed via `env:`, never interpolated into a run body",
    ).toEqual([]);
  });

  test("every step that consumes the cms slug binds it through `env:`", () => {
    // The positive half of the guard above: a future edit that simply DELETES
    // the slug usage would pass the negative lint. Assert the four consuming
    // steps still receive it, and via env.
    const bound = [];
    for (const job of Object.values(workflow().jobs || {})) {
      for (const step of (job && job.steps) || []) {
        const env = (step && step.env) || {};
        for (const value of Object.values(env)) {
          if (
            typeof value === "string" &&
            /\$\{\{[^}]*steps\.cms_slug\.outputs\.slug[^}]*\}\}/.test(value)
          ) {
            bound.push(step.name);
          }
        }
      }
    }
    // Six consumers, all via env: the two github-script steps that were
    // always env-bound (deployment registration + PR comment), plus the four
    // shell steps converted by #259 — deploy's alias sync and invalidation,
    // teardown's alias delete and invalidation.
    expect(
      bound.length,
      `expected 6 env-bound cms-slug consumers, found ${bound.length}: ${bound.join(", ")}`,
    ).toBe(6);
  });

  test("PR-comment renders the cms-slug alias URL when applicable", () => {
    // The comment-builder branches on `slug` and renders an extra
    // table row mentioning the alias URL.
    expect(
      workflowStrings(),
      "PR comment is missing the cms-slug alias row — editors won't see the stable URL",
    ).toMatch(/CMS slug alias[\s\S]{0,200}stable across draft cycles/);
  });
});

// ── Slug-derivation: run the real scripts/cms-preview-slug.sh ───────────
//
// `preview-cms-` (12) + slug must stay within the 63-octet DNS-label limit,
// so slug <= 51. Short slugs pass through unchanged; over-long ones are
// truncated and suffixed with a content hash so the alias host is always
// valid, deterministic, and collision-resistant.

const MAX_SLUG = 51;
const MAX_HOST_LABEL = 63; // "preview-cms-" (12) + slug

test.describe("cms-preview-slug.sh", () => {
  test("non-cms branch yields an empty slug (no alias)", () => {
    expect(slug("claude/some-feature")).toBe("");
    expect(slug("feat/foo")).toBe("");
    expect(slug("")).toBe("");
  });

  test("short slugs pass through unchanged", () => {
    expect(slug("cms/posts/foo-bar")).toBe("posts-foo-bar");
    expect(slug("cms/posts/2099-01-01-foo-bar")).toBe("posts-2099-01-01-foo-bar");
    expect(slug("cms/pages/about")).toBe("pages-about");
    expect(slug("cms/projects/category/item")).toBe("projects-category-item");
  });

  test("a 51-char slug is the boundary and stays unchanged", () => {
    // "posts-" (6) + 45 chars = 51.
    const branch = `cms/posts/${"a".repeat(45)}`;
    const out = slug(branch);
    expect(out).toBe(`posts-${"a".repeat(45)}`);
    expect(out.length).toBe(MAX_SLUG);
  });

  test("a 52-char slug overflows and is bounded", () => {
    const branch = `cms/posts/${"a".repeat(46)}`; // raw slug = 52
    const out = slug(branch);
    expect(out.length).toBeLessThanOrEqual(MAX_SLUG);
    expect(out).not.toBe(`posts-${"a".repeat(46)}`);
  });

  test("the real PR-941 branch produces a valid bounded host", () => {
    const branch =
      "cms/posts/2026-05-17-safely-keep-your-agent-iterating-autonomously-with-gitleaks-and-pr-comments";
    const out = slug(branch);
    expect(out.length).toBeLessThanOrEqual(MAX_SLUG);
    expect(`preview-cms-${out}`.length).toBeLessThanOrEqual(MAX_HOST_LABEL);
    // Lowercase DNS-label charset, no leading/trailing hyphen.
    expect(out).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  test("over-long slugs are deterministic (stable across draft cycles)", () => {
    const branch =
      "cms/posts/2026-05-17-safely-keep-your-agent-iterating-autonomously-with-gitleaks-and-pr-comments";
    expect(slug(branch)).toBe(slug(branch));
  });

  test("hostile refs are constrained to the router's [a-z0-9-] charset", () => {
    // Security regression guard (#259). The script's own header declares the
    // CloudFront router matches `^preview-cms-([a-z0-9-]+)\.<apex>$`, but
    // nothing enforced that charset: `cms/a/'$(id)'` passed a single quote
    // straight through to a workflow line of the shape `SLUG='<slug>'`, which
    // rendered as `SLUG='a-'$(id)''` and executed `id` under the deploy role.
    // Anything outside the declared charset now folds to a hyphen.
    const hostile = [
      "cms/a/'$(id)'",
      'cms/a/"; id #',
      "cms/a/`id`",
      "cms/a/$(id)",
      "cms/a/x&&id",
      "cms/a/x\\;id",
      "cms/a/x|id",
      "cms/posts/naïve-café",
    ];
    for (const branch of hostile) {
      const out = slug(branch);
      expect(out, `slug(${JSON.stringify(branch)}) escaped the charset: ${out}`).toMatch(
        /^[a-z0-9-]*$/,
      );
      // And never a shell metacharacter, however the charset is spelled.
      expect(out).not.toMatch(/['"`$;&|\\<>()]/);
    }
  });

  test("sanitised slugs carry no leading/trailing or doubled hyphen", () => {
    // The router regex tolerates them but a DNS label may not start or end
    // with a hyphen, and doubled hyphens make the 51-char bound spend budget
    // on nothing. Folding punctuation to `-` produces both without a collapse.
    expect(slug("cms/posts/--foo--bar--")).toBe("posts-foo-bar");
    expect(slug("cms/posts/a...b")).toBe("posts-a-b");
    expect(slug("cms/posts/foo!")).toBe("posts-foo");
  });

  test("a ref that sanitises to nothing yields an empty slug, not a bare prefix", () => {
    // Downstream steps gate on `slug != ''`, so an all-punctuation entry must
    // skip the alias entirely rather than publish to a `cms-/` prefix.
    expect(slug("cms/!!!")).toBe("");
    expect(slug("cms/")).toBe("");
  });

  test("over-long slugs sharing a 42-char prefix stay distinct (hash suffix)", () => {
    // Both flatten to `posts-` + a run of 'a's long enough that their
    // first 42 chars are identical — truncation alone would collide; the
    // content-hash suffix keeps them apart.
    const a = slug(`cms/posts/${"a".repeat(60)}`);
    const b = slug(`cms/posts/${"a".repeat(59)}b`);
    expect(a.slice(0, 42)).toBe(b.slice(0, 42));
    expect(a).not.toBe(b);
  });
});
