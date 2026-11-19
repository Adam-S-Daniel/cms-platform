// @lane: local — pure-fs lint of the two reusables that hold a WRITE credential
// on a consumer's push-back path — `platform-bump.yml` (rewrites
// `.github/workflows/*`, so its push needs `workflows: write`) and
// `dev-hooks-sync.yml` — plus their `examples/site` thin callers.
// Platform-internal (reads this repo's workflows + templates), so it is
// registered in playwright.config.js PLATFORM_META_SPECS and testIgnored on
// consumer lanes.
//
// WHY (cms-platform#238): both consumers held that credential as a fine-grained
// PAT, `CMS_PLATFORM_PAT` — one per owner, because a fine-grained PAT cannot
// span owners — and a PAT expires on a calendar. When it does, the ONLY
// platform down-sync path (`platform-bump`) stops, on a schedule, silently
// (`scheduled-run-health` reports it a day later). A GitHub App installation
// token is minted per run, lives ~1 h, and one App installed on both owners
// serves both consumers, so the rotation deadline disappears rather than
// moving. These lints lock the conversion so it cannot regress to PAT-only:
//
//   1. each reusable ACCEPTS the App's private key as an optional secret,
//      `app_private_key`. The `gh_token` PAT input was REMOVED in v0.1.103;
//   2. each MINTS an installation token from `vars.CMS_AUTOMATION_APP_ID` (a
//      reusable reads `vars.*` from the CALLER's repo) + that secret through
//      scripts/mint-app-token.js, scoped DOWN at mint time to the caller repo
//      (`--repositories`) and to the narrowest permission set the job needs —
//      `workflows=write` for the bump, which rewrites workflow files, and NOT
//      for dev-hooks-sync, which never touches one;
//   3. the App token is the credential on EVERY one the job resolves (the
//      checkout token that git persists for the bump's push, and the `gh`
//      GH_TOKEN). dev-hooks-sync's GH_TOKEN is the App token ALONE (#871):
//      `github.token` cannot create a pull request while "Allow GitHub Actions
//      to create and approve pull requests" is off, so a fallback to it only
//      hid the missing App behind a later, unexplained `gh pr create` failure;
//   4. the mint FAILS LOUDLY when the App is not provisioned: one `::error::`
//      naming BOTH knobs and exit 1, in both reusables (the PAT path it once
//      fell back to was removed in v0.1.103, dev-hooks-sync's `github.token`
//      path in #871); a present-but-broken key is the script's own failure;
//   5. the thin-caller TEMPLATES pass both secrets, so the next platform-bump
//      lands the secrets-map change on every consumer — #29's
//      `structuralShape()` compares each caller's `secrets:` map against the
//      template at the consumer's pinned ref, which is why the consumer edit
//      must ride the bump PR and never a PR of its own.
//
// Step order, which keys exist, and a step's `with:`/`env:` are CODE SHAPE and
// are read from the YAML AST (workflow-yaml-utils' `parseYaml`). Matching a
// token EXPRESSION or a flag inside one already-extracted `run:` string is the
// "leaf token's own content" concern AGENTS.md carves regex back in for.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const TEMPLATES = path.join(__dirname, "..", "examples", "site", ".github", "workflows");

// platform-bump's resolution, whitespace-normalised: the App token, then the
// job's own GITHUB_TOKEN (its mint step has already failed without the App, so
// the second operand is never the push credential).
const RESOLUTION = (mintId) =>
  `\${{ steps.${mintId}.outputs.token || github.token }}`;
// dev-hooks-sync's: the App token and nothing else (#871).
const APP_ONLY = (mintId) => `\${{ steps.${mintId}.outputs.token }}`;
const norm = (s) => String(s).replace(/\s+/g, " ").trim();

function load(file, job) {
  const wf = parseYaml(readWorkflow(file));
  const steps = wf.jobs[job].steps;
  const mintIdx = steps.findIndex(
    (s) => typeof s.run === "string" && /mint-app-token\.js/.test(s.run),
  );
  return { wf, steps, mintIdx, mint: mintIdx === -1 ? null : steps[mintIdx] };
}

// `permissions` as the mint step spells them: `--permissions a=b,c=d`.
function mintedPermissions(run) {
  const m = run.match(/--permissions\s+"?([A-Za-z_=,]+)"?/);
  return m ? Object.fromEntries(m[1].split(",").map((kv) => kv.split("="))) : null;
}

for (const { file, job, wantsWorkflows } of [
  { file: "platform-bump.yml", job: "bump", wantsWorkflows: true },
  { file: "dev-hooks-sync.yml", job: "sync", wantsWorkflows: false },
]) {
  test.describe(`${file}: GitHub App token replaces CMS_PLATFORM_PAT (#238)`, () => {
    test("accepts the App private key, and no longer declares the gh_token PAT", () => {
      const { wf } = load(file, job);
      const secrets = wf.on.workflow_call.secrets || {};
      expect(
        secrets.gh_token,
        "the gh_token PAT input was removed in v0.1.103 — declaring it again " +
          "would reinstate a dated credential path nobody holds",
      ).toBeUndefined();
      expect(secrets.app_private_key, "must declare secrets.app_private_key").toBeTruthy();
      expect(secrets.app_private_key.required, "the App is opt-in: required must be false").toBe(
        false,
      );
    });

    test("mints from vars.CMS_AUTOMATION_APP_ID + secrets.app_private_key, scoped to the caller repo", () => {
      const { mint } = load(file, job);
      expect(mint, "a run step invoking mint-app-token.js must exist").toBeTruthy();
      expect(mint.id, "the mint step needs an id so later steps can read its token").toBeTruthy();
      expect(norm(mint.env.APP_CLIENT_ID)).toBe("${{ vars.CMS_AUTOMATION_APP_ID }}");
      expect(norm(mint.env.APP_PRIVATE_KEY)).toBe("${{ secrets.app_private_key }}");
      expect(mint.run, "scope the token to the ONE repo this job runs in").toMatch(
        /--repositories\s+"\$\{GITHUB_REPOSITORY#\*\/\}"/,
      );
      const perms = mintedPermissions(mint.run);
      expect(perms, "the mint must pass an explicit --permissions scope-down").toBeTruthy();
      expect(perms.pull_requests).toBe("write");
      if (wantsWorkflows) {
        expect(perms.contents, "the bump pushes a branch").toBe("write");
        expect(perms.workflows, "the bump rewrites .github/workflows/*").toBe("write");
      } else {
        expect(perms.workflows, "dev-hooks-sync never writes a workflow file").toBeUndefined();
      }
    });

    test("names both knobs when the App is not provisioned, at the right severity", () => {
      const { mint } = load(file, job);
      expect(mint.run).toMatch(/-z "\$APP_CLIENT_ID"/);
      expect(mint.run).toMatch(/-z "\$APP_PRIVATE_KEY"/);
      // Whatever the severity, BOTH knobs are named — that is what keeps
      // "never onboarded" distinguishable from "misconfigured".
      expect(mint.run).toMatch(
        /::(error|warning)::[^\n]*CMS_AUTOMATION_APP_ID[^\n]*CMS_AUTOMATION_APP_PRIVATE_KEY/,
      );
      // Both ERROR and exit 1: neither job can do its work without the App.
      // platform-bump rewrites .github/workflows/*, which needs
      // workflows:write, and github.token cannot be granted it.
      // dev-hooks-sync opens a pull request, and github.token cannot create
      // one while "Allow GitHub Actions to create and approve pull requests"
      // is off, which repo-settings.yml keeps off on purpose (#871). Warning
      // and continuing only deferred the failure to an opaque `gh pr create`
      // refusal after the branch was already pushed.
      expect(
        mint.run,
        `${file} must ERROR and exit 1 without the App: its credential is load-bearing`,
      ).toMatch(/::error::[^\n]*CMS_AUTOMATION_APP_ID[\s\S]{0,400}exit 1/);
      expect(mint.run, "no path through the mint step may exit 0 without a token").not.toMatch(
        /exit 0/,
      );
    });
  });
}

test.describe("platform-bump.yml: the App token is the push credential (#238)", () => {
  test("mints BEFORE checkout, from the platform's own copy of the script, fetched over the API", () => {
    const { steps, mintIdx, mint } = load("platform-bump.yml", "bump");
    const checkoutIdx = steps.findIndex(
      (s) => typeof s.uses === "string" && /^actions\/checkout@/.test(s.uses),
    );
    expect(mintIdx, "mint step must exist").toBeGreaterThan(-1);
    expect(checkoutIdx, "checkout step must exist").toBeGreaterThan(-1);
    // The token has to exist before checkout persists it as the push
    // credential — and before checkout there is no tree, so the script comes
    // over the contents API (the shape this file already uses for
    // reconcile-nudge-contexts.py), pinned to the release the bump targets.
    expect(mintIdx, "the mint must precede the checkout that persists its token").toBeLessThan(
      checkoutIdx,
    );
    expect(mint.run).toMatch(/contents\/scripts\/mint-app-token\.js\?ref=/);
  });

  test("checkout token AND GH_TOKEN resolve App, then github.token — no PAT", () => {
    const { steps, mint } = load("platform-bump.yml", "bump");
    const checkout = steps.find(
      (s) => typeof s.uses === "string" && /^actions\/checkout@/.test(s.uses),
    );
    const bump = steps.find((s) => s.id === "bump");
    expect(bump, "the bump step is found by `id: bump` — the mint step reads the same endpoint").toBeTruthy();
    expect(norm(checkout.with.token)).toBe(RESOLUTION(mint.id));
    expect(norm(bump.env.GH_TOKEN)).toBe(RESOLUTION(mint.id));
  });
});

test.describe("dev-hooks-sync.yml: the App token opens the sync PR (#238)", () => {
  test("mints AFTER the platform checkout, from .cms-platform/scripts, and GH_TOKEN is the App token alone", () => {
    const { steps, mintIdx, mint } = load("dev-hooks-sync.yml", "sync");
    const platformIdx = steps.findIndex(
      (s) =>
        typeof s.uses === "string" &&
        /^actions\/checkout@/.test(s.uses) &&
        s.with &&
        s.with.path === ".cms-platform",
    );
    expect(platformIdx).toBeGreaterThan(-1);
    expect(mintIdx).toBeGreaterThan(platformIdx);
    expect(mint.run).toMatch(/node \.cms-platform\/scripts\/mint-app-token\.js/);
    const sync = steps.find((s) => typeof s.run === "string" && /gh pr create/.test(s.run));
    expect(norm(sync.env.GH_TOKEN)).toBe(APP_ONLY(mint.id));
  });

  test("no step falls back to github.token, and none claims GITHUB_TOKEN opens the PR (#871)", () => {
    const { wf, steps } = load("dev-hooks-sync.yml", "sync");
    for (const step of steps) {
      for (const [key, value] of Object.entries({ ...(step.env || {}), ...(step.with || {}) })) {
        expect(String(value), `step "${step.name || step.uses}" ${key}`).not.toMatch(
          /github\.token|secrets\.GITHUB_TOKEN/,
        );
      }
      if (typeof step.run === "string") {
        expect(step.run, `step "${step.name}" run`).not.toMatch(/opened by GITHUB_TOKEN/);
      }
    }
    expect(wf.on.workflow_call.secrets.app_private_key.description).not.toMatch(
      /opened by GITHUB_TOKEN/,
    );
  });
});

test.describe("examples/site thin callers pass the App key and NOT the PAT (#238)", () => {
  for (const [file, job] of [
    ["platform-bump.yml", "bump"],
    ["dev-hooks-sync.yml", "sync"],
  ]) {
    test(`${file} forwards CMS_AUTOMATION_APP_PRIVATE_KEY and no longer forwards a PAT`, () => {
      const caller = parseYaml(fs.readFileSync(path.join(TEMPLATES, file), "utf8"));
      const secrets = caller.jobs[job].secrets;
      expect(
        secrets.gh_token,
        "a template must not pass gh_token: the reusable no longer declares it, " +
          "so a caller that does fails at startup",
      ).toBeUndefined();
      expect(norm(secrets.app_private_key)).toBe("${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}");
    });
  }
});
