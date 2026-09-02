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
//      `app_private_key`, next to the `gh_token` PAT it already took;
//   2. each MINTS an installation token from `vars.CMS_AUTOMATION_APP_ID` (a
//      reusable reads `vars.*` from the CALLER's repo) + that secret through
//      scripts/mint-app-token.js, scoped DOWN at mint time to the caller repo
//      (`--repositories`) and to the narrowest permission set the job needs —
//      `workflows=write` for the bump, which rewrites workflow files, and NOT
//      for dev-hooks-sync, which never touches one;
//   3. the App token WINS when the App is provisioned — App, then PAT, then
//      `github.token` — on EVERY credential the job resolves (the checkout
//      token that git persists for the push, and the `gh` GH_TOKEN), so
//      provisioning the App is what retires the PAT, with no second switch;
//   4. the mint FAILS SOFT when the App is not provisioned (v0.1.76 rule): one
//      `::notice::` naming BOTH knobs, then the PAT path exactly as before;
//      a present-but-broken key is the script's own loud failure;
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

// The exact resolution order, whitespace-normalised: App token, then the PAT,
// then the job's own GITHUB_TOKEN.
const RESOLUTION = (mintId) =>
  `\${{ steps.${mintId}.outputs.token || secrets.gh_token || github.token }}`;
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
    test("accepts the App private key as an optional secret beside gh_token", () => {
      const { wf } = load(file, job);
      const secrets = wf.on.workflow_call.secrets || {};
      expect(secrets.gh_token, "the PAT input stays — it is the fallback").toBeTruthy();
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

    test("fails SOFT when the App is not provisioned, naming both knobs", () => {
      const { mint } = load(file, job);
      // Both env presence checks, then the notice — a missing App is not an
      // error, it is "run on the PAT as before".
      expect(mint.run).toMatch(/-z "\$APP_CLIENT_ID"/);
      expect(mint.run).toMatch(/-z "\$APP_PRIVATE_KEY"/);
      expect(mint.run).toMatch(/::notice::[^\n]*CMS_AUTOMATION_APP_ID[^\n]*CMS_AUTOMATION_APP_PRIVATE_KEY/);
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

  test("checkout token AND GH_TOKEN resolve App, then PAT, then github.token", () => {
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
  test("mints AFTER the platform checkout, from .cms-platform/scripts, and GH_TOKEN resolves App first", () => {
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
    expect(norm(sync.env.GH_TOKEN)).toBe(RESOLUTION(mint.id));
  });
});

test.describe("examples/site thin callers pass both secrets (#238)", () => {
  for (const [file, job] of [
    ["platform-bump.yml", "bump"],
    ["dev-hooks-sync.yml", "sync"],
  ]) {
    test(`${file} forwards CMS_PLATFORM_PAT and CMS_AUTOMATION_APP_PRIVATE_KEY`, () => {
      const caller = parseYaml(fs.readFileSync(path.join(TEMPLATES, file), "utf8"));
      const secrets = caller.jobs[job].secrets;
      expect(norm(secrets.gh_token)).toBe("${{ secrets.CMS_PLATFORM_PAT }}");
      expect(norm(secrets.app_private_key)).toBe("${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}");
    });
  }
});
