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
//      from `head_ref` via the SAME shared scripts/cms-preview-slug.sh
//      (otherwise a cleanup mismatch would orphan S3 files when the slug
//      shape drifts). Because teardown has no build step of its own, it
//      gains a Checkout so the script is on disk.
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
// run the real script.

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
    const matches = workflowStrings().match(/\.\/scripts\/cms-preview-slug\.sh/g) || [];
    expect(
      matches.length,
      `expected exactly two cms-preview-slug.sh call sites (deploy + teardown); found ${matches.length}`,
    ).toBe(2);
  });

  test("both jobs check out the repo so the shared script is on disk", () => {
    // The deploy job always checked out; teardown now must too (it has no
    // build step that would otherwise put scripts/ on disk). Two checkouts
    // total guards against a future edit dropping the teardown one and
    // breaking the slug computation at PR-close.
    const checkouts = allSteps().filter(
      (s) => s && typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"),
    );
    expect(
      checkouts.length,
      `expected a Checkout in both deploy + teardown; found ${checkouts.length}`,
    ).toBe(2);
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
