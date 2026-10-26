// @lane: local — PURE-FS lint; runs the workflows' own build `run:` scripts against a stub `bundle` (no Jekyll, no browser, no network)
/*
 * A brand-new draft must render on its own PR preview (#637).
 *
 * Decap saves a new entry with Published OFF, i.e. `published: false` in its
 * front matter. Jekyll skips such an entry unless the build passes
 * `--unpublished`, so before this fix the draft's `preview-pr<N>.<apex>/blog/
 * <slug>/` page 404'd and the post was missing from that preview's /blog/.
 *
 * The contract, held here:
 *   1. deploy-preview.yml's build passes `--unpublished` when the PR is a
 *      Decap editorial PR (a `cms/*` head ref, so the `cms_slug` step's
 *      output is non-empty).
 *   2. Any other PR's preview keeps production's publish semantics: no flag.
 *      The preview-env loops (cms-unpublish-republish-preview,
 *      cms-publish-loop-prod-mutate-preview) assert a `published: false`
 *      fixture 4xxs on their non-cms parent PR's preview.
 *   3. The production builds (deploy-production.yml, site-verify.yml) never
 *      pass it, whatever the environment says.
 *
 * Each workflow is parsed with the `yaml` parser (workflow-yaml-utils.js) and
 * the build step's real `run:` script is executed by bash with a stub
 * `bundle` first on PATH that records its arguments, so a comment that
 * mentions the flag cannot satisfy (or trip) the lint and the gate's shell
 * logic is exercised rather than pattern-matched.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const SLUG_EXPR = "${{ steps.cms_slug.outputs.slug }}";

// Steps whose run script invokes `jekyll build`. Lexical by design: it looks
// for the command's two words on a non-comment line, not at code structure.
function jekyllBuildSteps(job) {
  return ((job && job.steps) || []).filter((step) =>
    String((step && step.run) || "")
      .split(/\r?\n/)
      .some((line) => !line.trim().startsWith("#") && /\bjekyll\s+build\b/.test(line)),
  );
}

// Run a step's script with a stub `bundle` that writes one argument per line.
// Returns the recorded argument list.
function runWithStub(script, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-unpublished-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const out = path.join(dir, "bundle-args");
    fs.writeFileSync(
      path.join(bin, "bundle"),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$STUB_OUT"\n',
      { mode: 0o755 },
    );
    const res = spawnSync("bash", ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        STUB_OUT: out,
        ...env,
      },
    });
    expect(res.status, `build script exited ${res.status}: ${res.stderr}`).toBe(0);
    return fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.describe("deploy-preview.yml: a cms/* draft preview includes unpublished entries (#637)", () => {
  const job = (parseYaml(readWorkflow("deploy-preview.yml")).jobs || {})["deploy-preview"];

  function buildStep() {
    const steps = jekyllBuildSteps(job);
    expect(steps.length, "deploy-preview must run exactly one `jekyll build` step").toBe(1);
    return steps[0];
  }

  test("the build step reads the cms_slug output, computed by an earlier step", () => {
    const step = buildStep();
    expect(step.env && step.env.CMS_SLUG, "build step must bind CMS_SLUG from the cms_slug step").toBe(
      SLUG_EXPR,
    );
    const slugAt = job.steps.findIndex((s) => s && s.id === "cms_slug");
    expect(slugAt, "deploy-preview must have a step with id cms_slug").toBeGreaterThanOrEqual(0);
    expect(slugAt, "cms_slug must run before the build").toBeLessThan(job.steps.indexOf(step));
  });

  test("a Decap editorial PR (non-empty slug) builds with --unpublished", () => {
    const args = runWithStub(buildStep().run, { JEKYLL_ENV: "preview", CMS_SLUG: "posts-my-new-draft" });
    expect(args).toEqual(["exec", "jekyll", "build", "--destination", "./_site_preview", "--unpublished"]);
  });

  test("any other PR (empty slug) keeps production's publish semantics", () => {
    const args = runWithStub(buildStep().run, { JEKYLL_ENV: "preview", CMS_SLUG: "" });
    expect(args).toEqual(["exec", "jekyll", "build", "--destination", "./_site_preview"]);
  });
});

test.describe("production builds never include unpublished entries (#637)", () => {
  for (const name of ["deploy-production.yml", "site-verify.yml"]) {
    test(`${name}: no build passes --unpublished`, () => {
      const jobs = parseYaml(readWorkflow(name)).jobs || {};
      const steps = Object.values(jobs).flatMap(jekyllBuildSteps);
      expect(steps.length, `${name} must run a jekyll build`).toBeGreaterThan(0);
      for (const step of steps) {
        // A non-empty CMS_SLUG in the environment must not change a
        // production build: only deploy-preview.yml reads it.
        const args = runWithStub(step.run, { JEKYLL_ENV: "production", CMS_SLUG: "posts-my-new-draft" });
        expect(args.slice(0, 3)).toEqual(["exec", "jekyll", "build"]);
        expect(args, `${name} "${step.name}" must not pass --unpublished`).not.toContain("--unpublished");
      }
    });
  }
});
