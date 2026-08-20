// @lane: local — pure-fs, CONSUMER-ONLY lint (parses with the `yaml` library,
// never regex) binding a live cms-platform consumer's OWN
// `cms-automerge-nudge.yml` `required_contexts` to the required-status-check
// set its OWN `main` ruleset declares.
//
// WHY THIS EXISTS (#284)
// ---------------------
// `required_contexts` is the nudge's entire notion of "green": the reusable
// builds a `REQUIRED` set out of it and gates on every member being green
// before it calls `pulls.merge()`. A list SHORTER than the repo's real required
// set therefore asks for a merge it has not established.
//
// That is not hypothetical. jodidaniel.com's caller passed exactly ONE context
// (`editorial / validate-content`) while its live `main` ruleset required six,
// and had done since the value was seeded — every one of the six commits that
// touched the file in between is a `chore: bump cms-platform to vX`. It was
// harmless only because that site is gated (no editorial traffic) and because
// `pulls.merge()` itself respects branch protection and answered 405. A guard
// that requests a merge on evidence it has not gathered is safe by accident,
// and only for as long as the ruleset holds. Fixed in jodidaniel.com#156.
//
// The failure has two directions and the platform's guidance only ever warned
// about one of them. A WRONG entry makes the nudge wait forever for a context
// no run will ever report — the documented hazard, which silently disables
// stuck-PR recovery. A SHORT list is the inverse: acting too early rather than
// never. Nothing warned about it, and nothing checked for it.
//
// WHY NOTHING CAUGHT IT
// ---------------------
//   - `e2e/cms-automerge-nudge.test.js` locks the same list, but against the
//     platform TEMPLATE only, and a consumer's list is legitimately allowed to
//     differ from the template's (the template's own comment says "DERIVE
//     THESE, don't copy them"). Both files live in the platform, so that lock
//     is entirely platform-side and never looks at a site.
//   - the consumer pin-consistency check DOES compare a consumer's workflows
//     against the canonical template, but its structural comparison
//     deliberately compares `with:` KEY-SETS, not values — so this value is
//     explicitly outside what it looks at.
//   - the consumer keeps no local copy of the authoritative list. A
//     `.github/rulesets/main.json` exists in exactly one consumer and is a dead
//     vestige nothing reads.
//
// THE ORACLE, AND WHERE IT COMES FROM
// -----------------------------------
// The authoritative per-repo declaration is the platform's own
// `repo-settings.yml`: `repos[<owner/repo>].rulesets.main` names an entry in
// `ruleset_library`, and THAT entry's `required_status_checks` is the list the
// applier PUTs live. A consumer checkout does not carry that file — but a
// consumer e2e LANE does. `e2e-tests.yml`'s project job checks the WHOLE
// platform out (no `sparse-checkout:`) into `.cms-platform` and exports
// `SITE_ROOT` = `github.workspace` and `CMS_REPO` = `github.repository`. Every
// other lane that runs this harness against a site checks the platform out the
// same full way. So `<SITE_ROOT>/.cms-platform/repo-settings.yml` is readable
// here, `repos:` is keyed by `owner/repo`, and a site can look ITSELF up.
//
// TWO OBJECTIONS THAT HELD THIS BACK, AND HOW THEY ARE RESOLVED
// -------------------------------------------------------------
// 1. THE MANIFEST A CONSUMER READS IS PINNED, NOT LIVE — it is the copy at the
//    site's own `platform_ref`, so it lags, and it lags in the false-GREEN
//    direction: a consumer pinned behind a manifest change that ADDED a context
//    agrees with its own stale copy. Accepted deliberately, and stated rather
//    than hidden. Reading the live ruleset means a network call, which this
//    suite forbids. What is left is still a real, monotone lower bound: the
//    window is one release wide, because a platform bump moves `platform_ref`
//    and every `uses:@` ref together, and the platform-side template lock keeps
//    the template equal to the current manifest — so the next bump both
//    refreshes the manifest a site reads AND drags the template list past it. A
//    pinned-manifest check WOULD have caught jodidaniel.com#156: the manifest
//    converged that site onto `consumer-main` on 2026-07-22, months before the
//    caller was fixed.
//
// 2. A SITE ABSENT FROM `repos:` HAS NO DECLARED LIST TO COMPARE AGAINST. The
//    objection was that this needs an "absent from the manifest" SKIP, and that
//    a soft path would land on precisely the sites with the least review behind
//    them. That is the argument for FAILING, not for skipping. The fleet
//    contract is that rulesets change ONLY through a `repo-settings.yml` PR, so
//    a site missing from `repos:` has no MANAGED ruleset at all and its nudge's
//    notion of green is anchored to nothing — which is the exact condition this
//    lint exists to make loud. The failure message names the fix.
//
// CONSUMER ONLY, never platform, and deliberately NOT in PLATFORM_META_SPECS.
// `playwright.config.js` testIgnores every registered name on a CONSUMER lane,
// so registering this one would silently void it on the exact repos it exists
// to protect — the cms-platform#244 lesson that also keeps
// `e2e/consumer-required-check-mirrors.test.js` and
// `e2e/dependabot-theme-gem-ignored.test.js` off that list. This file follows
// the first of those two byte-for-byte in shape.
//
// Two lints had to be checked rather than assumed before this could be written:
//   - `e2e/admin-spec-source-read-lint.test.js` polices consumer-facing specs
//     for platform-SOURCE admin reads. It does not object, on two independent
//     counts: it scans only `*.spec.js` files (this is a `*.test.js`), and its
//     forbidden patterns are `theme/admin` and the legacy vendored `../admin`,
//     neither of which a `.cms-platform` read matches.
//   - the meta-spec registry's `workflows-def` detector treats a `.github` +
//     `workflows` path join as platform-internal UNLESS EVERY such join in the
//     file is rooted at SITE_ROOT, and treats a require of the shared
//     workflow-YAML helper as an unconditional platform signal. Both are
//     respected below: the one workflows-dir join is SITE_ROOT-rooted, and the
//     `yaml` library is required directly rather than through the helper — the
//     same reason `e2e/dependabot-config-utils.js` reaches for it directly.
//
// Skip semantics: `test.skip()` fires ONLY when SITE_ROOT is unset (the
// platform's own self-CI, where `e2e/cms-automerge-nudge.test.js` is this
// invariant's template-side coverage). A genuinely SITE_ROOT-having run whose
// site is missing the caller, or whose lane is missing the platform checkout,
// FAILS — an input that vanished is not a finding of "nothing wrong".
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const CONSUMER = !!process.env.SITE_ROOT;
const SITE_ROOT = process.env.SITE_ROOT || null;

// The consumer's own thin caller. This is the ONE workflows-dir join in the
// file and it is SITE_ROOT-rooted, which is what keeps the registry's
// `workflows-def` detector from misreading this consumer spec as
// platform-internal (see the header).
const CALLER_PATH = CONSUMER
  ? path.join(SITE_ROOT, ".github", "workflows", "cms-automerge-nudge.yml")
  : null;

// The platform manifest as the consumer's own lane checked it out — the copy
// pinned at this site's `platform_ref`, which is the honest oracle available
// without a network call (header, objection 1).
const MANIFEST_PATH = CONSUMER ? path.join(SITE_ROOT, ".cms-platform", "repo-settings.yml") : null;

// The site's own Jekyll config, used only as the last-resort identity source.
const SITE_CONFIG_PATH = CONSUMER ? path.join(SITE_ROOT, "_config.yml") : null;

const NUDGE_REUSABLE_MARKER = "cms-automerge-nudge.yml@";

const SKIP_REASON =
  "SITE_ROOT is unset (platform self-CI) — no consuming site's .github/workflows tree and no " +
  ".cms-platform checkout are present here; see e2e/cms-automerge-nudge.test.js for the " +
  "platform-mode coverage of this same invariant against the examples template caller.";

// Read + parse one YAML file, asserting it parses to a real MAPPING. The read
// sits OUTSIDE any try/catch on purpose: an ENOENT or a permissions failure
// must surface as the error it is, never be folded into a "malformed input we
// decided to tolerate" branch.
function parseMapping(label, file, missingHint) {
  expect(fs.existsSync(file), `${file} does not exist. ${missingHint}`).toBe(true);
  const doc = YAML.parse(fs.readFileSync(file, "utf8"), { merge: true });
  expect(
    doc !== null && typeof doc === "object" && !Array.isArray(doc),
    `${label}: must parse to a YAML MAPPING (got ${JSON.stringify(doc)}). An empty or scalar ` +
      `file parses to null/a string, and every lookup below would then compare two absences ` +
      `and pass vacuously.`,
  ).toBe(true);
  return doc;
}

function callerDoc() {
  return parseMapping(
    "cms-automerge-nudge.yml",
    CALLER_PATH,
    "This site is missing the auto-merge nudge caller. It is part of the platform-dictated " +
      "workflow set (the pin-consistency check reports it as MISSING), and without it a stuck " +
      "editorial PR is never recovered. Ship the caller, or drop the nudge from the " +
      "platform-dictated set deliberately.",
  );
}

function manifestDoc() {
  return parseMapping(
    "repo-settings.yml",
    MANIFEST_PATH,
    "The platform checkout this lint reads its oracle from is absent. Every lane that runs this " +
      "harness against a site checks the WHOLE platform out to `.cms-platform` (no " +
      "`sparse-checkout:`), so its absence means the harness is running outside such a lane — " +
      "not that there is nothing to check.",
  );
}

// `owner/repo` for the site under test. `CMS_REPO` is exported by every lane
// that runs this harness against a site (`github.repository`);
// `GITHUB_REPOSITORY` is the same value under its stock name; the site's own
// `cms.repository` is the site-owned last resort, which also makes a local run
// against a plain site checkout work. No default — guessing an identity here
// would silently compare a site against some OTHER repo's ruleset.
function siteSlug() {
  const fromEnv = process.env.CMS_REPO || process.env.GITHUB_REPOSITORY;
  if (fromEnv && fromEnv.includes("/")) return String(fromEnv).trim();
  if (fs.existsSync(SITE_CONFIG_PATH)) {
    const cfg = YAML.parse(fs.readFileSync(SITE_CONFIG_PATH, "utf8"), { merge: true });
    const declared = cfg && cfg.cms && cfg.cms.repository;
    if (declared && String(declared).includes("/")) return String(declared).trim();
  }
  return null;
}

// The newline-separated `required_contexts` block the site actually passes,
// normalised the way the reusable itself normalises it: split on newlines,
// trim, drop blanks.
function passedContexts(doc) {
  const jobs = (doc && doc.jobs) || {};
  const nudgeJobs = Object.keys(jobs).filter(
    (name) =>
      jobs[name] && typeof jobs[name].uses === "string" && jobs[name].uses.includes(NUDGE_REUSABLE_MARKER),
  );
  expect(
    nudgeJobs,
    "cms-automerge-nudge.yml must contain exactly ONE job calling the platform's auto-merge " +
      "nudge reusable. The job is located by its `uses:` rather than by name so a renamed job " +
      "is still checked; zero means this file is not the caller this lint thinks it is, and " +
      "more than one means two nudges race on the same PRs with independent notions of green.",
  ).toHaveLength(1);
  const withBlock = (jobs[nudgeJobs[0]] && jobs[nudgeJobs[0]].with) || {};
  return String(withBlock.required_contexts == null ? "" : withBlock.required_contexts)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// The required-status-check contexts this repo's OWN `main` ruleset declares,
// resolved through the manifest's two-level indirection: `repos[slug]
// .rulesets.main` names a `ruleset_library` entry, and that entry's `rules`
// array carries the `required_status_checks` rule KEYED BY TYPE, not by
// position. Every step is a navigation of PARSED YAML.
function declaredContexts(manifest, slug) {
  const repos = manifest.repos || {};
  const entry = repos[slug];
  expect(
    entry,
    `${slug} is not declared under \`repos:\` in the platform's repo-settings manifest. The ` +
      `fleet contract is that rulesets change ONLY through a PR to that file, so a site absent ` +
      `from it has no MANAGED ruleset and this caller's notion of "green" is anchored to ` +
      `nothing — which is exactly the condition this lint exists to make loud, not a case to ` +
      `wave through. Add the repo to repo-settings.yml (mapping its \`main\` ruleset to the ` +
      `library entry its branch protection should enforce) and re-pin this site's ` +
      `platform_ref. Declared repos at this pin: ${Object.keys(repos).sort().join(", ") || "(none)"}.`,
  ).toBeTruthy();

  const rulesetName = entry.rulesets && entry.rulesets.main;
  expect(
    rulesetName,
    `${slug} declares no \`rulesets.main\` in the platform's repo-settings manifest. The nudge ` +
      `merges into \`main\`, so the \`main\` ruleset is the only declaration that can say what ` +
      `"green" means for it.`,
  ).toBeTruthy();

  const ruleset = (manifest.ruleset_library || {})[rulesetName];
  expect(
    ruleset,
    `${slug}'s \`main\` ruleset names the library entry \`${rulesetName}\`, which the manifest ` +
      `does not define. The mapping and the library must move together.`,
  ).toBeTruthy();

  const rule = ((ruleset.rules || []).filter(Boolean)).find(
    (r) => r && r.type === "required_status_checks",
  );
  expect(
    rule,
    `ruleset_library.${rulesetName} carries no \`required_status_checks\` rule. With none, ` +
      `${slug}'s main branch is gated on nothing and binding the nudge to it would mean nothing ` +
      `either — the nudge would be free to merge on no evidence at all.`,
  ).toBeTruthy();

  const contexts = ((rule.parameters || {}).required_status_checks || [])
    .filter(Boolean)
    .map((c) => String(c && c.context));
  return { rulesetName, contexts };
}

test.describe("consumer auto-merge nudge: required_contexts equals this repo's own main ruleset", () => {
  // Fail-on-zero. A lint that silently examines nothing looks exactly like a
  // lint that found nothing wrong — so make the count an assertion whose only
  // source is what actually parsed.
  test("this consumer's nudge caller and the pinned platform manifest both parsed", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const docs = [callerDoc(), manifestDoc()];
    const parsed = docs.filter((d) => d && typeof d === "object" && !Array.isArray(d));
    expect(parsed.length, "this lint must examine a non-zero number of files").toBeGreaterThan(0);
    expect(
      parsed.length,
      "both inputs must parse — the site's own nudge caller and the platform manifest its lane " +
        "checked out. Either one absent leaves the comparison below vacuous.",
    ).toBe(2);
  });

  test("the site under test resolves to an `owner/repo` identity", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    expect(
      siteSlug(),
      "could not determine which repo this site IS. Every lane that runs this harness against a " +
        "site exports CMS_REPO = github.repository; GITHUB_REPOSITORY and the site's own " +
        "`cms.repository` in _config.yml are the fallbacks. Without one of the three this lint " +
        "cannot look the site up in the manifest, and GUESSING would compare it against some " +
        "other repo's ruleset — a green that means nothing.",
    ).toBeTruthy();
  });

  // The reusable already fails loudly on an EMPTY list, so this is the cheap
  // half of the pair; the malformed-entry test below is the silent one.
  test("required_contexts is non-empty", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    expect(
      passedContexts(callerDoc()).length,
      "this site passes an empty `required_contexts`. The reusable refuses to run on that (it " +
        "sets the job failed), so the nudge is dead: no stuck editorial PR is ever recovered, " +
        "and the daily run reports the failure into a lane nobody reads.",
    ).toBeGreaterThan(0);
  });

  // The SILENT case. The reusable matches a required context by EXACT name
  // against the head sha's check-runs, falling back to a legacy commit status
  // of the same name; a mangled entry matches neither, so it can never go
  // green and the nudge waits on it forever. A GitHub Actions check-run context
  // is always `<workflow name> / <job name>`, which is the shape every entry a
  // managed ruleset declares for these repos takes today. A legacy commit
  // status genuinely has no slash — if one is ever REQUIRED, the manifest and
  // this expectation move together, deliberately and in one PR, rather than
  // this lint quietly widening to admit whatever it is shown.
  test("every required_contexts entry is ` / `-shaped", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const malformed = passedContexts(callerDoc()).filter((c) => !c.includes(" / "));
    expect(
      malformed,
      "these `required_contexts` entries are not `<workflow> / <job>`-shaped. The nudge matches " +
        "a required context by EXACT name against the head sha's check-runs, so a mangled entry " +
        "(a stray list dash, a wrapped line, a comment that leaked into the block) matches " +
        "nothing, never goes green, and silently disables stuck-PR recovery — the failure mode " +
        "with no error anywhere.",
    ).toEqual([]);
  });

  // THE #284 GATE.
  test("required_contexts SET equals this repo's declared main-ruleset required checks", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const slug = siteSlug();
    expect(slug, "identity must resolve before the set comparison can mean anything").toBeTruthy();

    const { rulesetName, contexts: declared } = declaredContexts(manifestDoc(), slug);
    expect(
      declared.length,
      `ruleset_library.${rulesetName}'s \`required_status_checks\` list is empty, so ${slug}'s ` +
        `main branch requires nothing and the nudge would be free to merge on no evidence.`,
    ).toBeGreaterThan(0);

    const passed = passedContexts(callerDoc());

    // SET, not sequence: neither the ruleset body nor the nudge's matcher cares
    // in what order the contexts are listed, so ordering churn must not red
    // this lint. A DUPLICATE would, and should — a repeated context is a
    // hand-edit accident, and the reusable's own Set silently swallows it.
    expect(
      [...passed].sort(),
      `${slug}'s \`required_contexts\` must equal the \`required_status_checks\` contexts its ` +
        `own \`main\` ruleset declares (\`ruleset_library.${rulesetName}\`), as a set. A SHORT ` +
        `list is the jodidaniel.com#156 defect: the nudge calls pulls.merge() having established ` +
        `only some of what branch protection requires, and is safe only for as long as the ` +
        `ruleset answers 405 on its behalf. An EXTRA or WRONG entry is the opposite failure — ` +
        `the nudge waits forever for a context no run reports, and stuck-PR recovery is silently ` +
        `off. Change repo-settings.yml and this caller together. NOTE the manifest read here is ` +
        `the copy pinned at this site's platform_ref, so if you have just changed it, this site ` +
        `sees the change only once its platform_ref is bumped.`,
    ).toEqual([...declared].sort());
  });
});
