# skill-impact.md — the cms-platform bundle's skill-change audit trail

Every change to a skill under `skills/` (the `cms-platform` bundle) gets an
entry here — creations, edits, renames, removals, and **rejected proposals**.
The rejected ones are the reason the file exists: git history records what
landed, but nothing records what was tried and turned down, so the next
session re-derives and re-proposes it. An approach already ruled out is the
expensive thing to lose. (Convention defined in skills-evals' `DESIGN.md`,
"Scaling to the registry", and copied from agentskills'
`docs/skill-impact.md`; the underlying evidence — a proposal audit trail is
what stops failed abstractions being re-proposed — is WikiSkill,
arXiv:2608.27454.)

What this file is NOT for: harness, hook, CI, lock or docs changes — only
skill content. Entries append in the same PR as the change, newest first.

A SKILL.md edit moves that skill's digest, so every consumer's `skills.lock`
pin of this bundle goes stale until the consumer re-pins; that re-pin is the
consumer's step, not the editing PR's.

## Entry format

```
## YYYY-MM-DD — <bundle>/<skill> — <create|edit|rename|remove|rejected>
- Motivation: one line — the incident, pattern, or issue that prompted it
- Change: one line — what changed (PR #NNN)
- Eval: the skill's eval result (exit code + counts), or "none — no eval
  exists yet", or "exempt (DESIGN.md non-coverage table)"
- Outcome: merged YYYY-MM-DD, or rejected YYYY-MM-DD — one line why. The
  full proposal survives in the closed PR; link it rather than pasting it.
```

Rules:

- **A rejected proposal is the highest-value entry.** Record it even when it
  feels like noise — especially then.
- **Append-only.** A wrong entry gets a correcting entry, not an edit.
- **This repo is public and scanned.** Nothing sensitive in an entry, ever;
  a sensitive rejection is recorded by PR link alone.

Entries before 2026-10-04 predate this file and live only in git history —
no backfill is planned; the file adds the fields git does not capture.

---

## 2026-10-05 — cms-platform/test-canary — edit

- Motivation: the skill cited closed skills-evals issue #17 as where its propagation probe would be built; #17 built arms against the registry's own bundle only, and no issue tracks a `cms-platform`-bundle probe.
- Change: the description and body now say the probe is not built and untracked, and link #17 only as what it did build.
- Eval: exempt (DESIGN.md non-coverage table)
- Outcome: pending merge.

## 2026-10-05 — cms-platform/consumer-repo-provisioning — edit

- Motivation: the install line named the retired `agentskills` marketplace; the live registry marketplace is `adam-agentskills`.
- Change: `cms-platform@agentskills` is now `cms-platform@adam-agentskills`.
- Eval: outstanding — the skills-evals fixture for this skill was not run in this change.
- Outcome: pending merge.

## 2026-10-05 — cms-platform/github-actions-sha-pinning — edit

- Motivation: the skill named the retired `agentskills` marketplace as the bundle's home.
- Change: now `adam-agentskills`.
- Eval: outstanding — the skills-evals fixture for this skill was not run in this change.
- Outcome: pending merge.

## 2026-10-04 — cms-platform/aws-bootstrap — edit

- Motivation: review of PR #567 found a mistyped `BOOTSTRAP_STACK_NAME` would create a new stack, which the change-set guard passes because a create is all `Add` actions.
- Change: the skill now documents `ALLOW_STACK_CREATE=1` for a site's first bootstrap, its refusal, and the fixed message for a failed change-set creation (https://github.com/Adam-S-Daniel/cms-platform/pull/567).
- Eval: exempt (DESIGN.md non-coverage table)
- Outcome: pending merge.

## 2026-10-04 — cms-platform/aws-bootstrap — edit

- Motivation: #566's S3 upload left a first create needing a bucket the stack itself creates, and `site-params.env`'s `STACK_NAME` (the OAuth proxy stack) could become the bootstrap stack's name; on a new site that create is all `Add` actions, which the change-set guard cannot catch.
- Change: the skill now documents the minified inline deploy (no `TEMPLATE_S3_BUCKET`), the destructive-change guard and `ALLOW_DESTRUCTIVE_CHANGES=1`, `BOOTSTRAP_STACK_NAME` in place of `STACK_NAME`, and the new refusals, including a stack in a failed state (https://github.com/Adam-S-Daniel/cms-platform/pull/567).
- Eval: exempt (DESIGN.md non-coverage table)
- Outcome: pending merge.

## 2026-10-04 — cms-platform/platform-release-and-bump — edit

- Motivation: the manual-bump recipe was a python global replace of the old version, the same text-wide rewrite platform-bump dropped in #530 because it re-dates prose that names the old version; a hand-regenerated bump would diverge from the workflow.
- Change: the recipe now calls `scripts/rewrite-platform-pins.js` (the workflow's own rewrite) and lists the pins it moves (PR #559).
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-04 — cms-platform/ci-watcher-loops — edit

- Motivation: the #408 freshness lint read the `X.yml` placeholder in the BROKEN-capture example as a workflow citation, which needed an allowlist entry for a name that was never meant to resolve.
- Change: the placeholder workflow name in the three example blocks is now `<workflow>.yml`, and the allowlist entry is gone (PR #563).
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-04 — cms-platform/platform-release-and-bump — edit

- Motivation: the #408 freshness lint found `secrets.gh_token` and
  `CMS_PLATFORM_PAT` cited as platform-bump's live fallback credential; both
  were removed in v0.1.103.
- Change: the credential paragraph now says the App token is the only path and
  a consumer without the App fails the bump (PR #563).
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-04 — cms-platform/consumer-repo-provisioning — edit

- Motivation: the #408 freshness lint flagged `CMS_PLATFORM_PAT`; the App
  section still described the "App → PAT → `GITHUB_TOKEN`" fallback removed in
  v0.1.103.
- Change: the App section now states there is no PAT fallback: platform-bump
  errors without the App, dev-hooks-sync warns and opens its PR as
  `GITHUB_TOKEN` (PR #563).
- Eval: none — no eval exists yet (a Class B candidate in skills-evals'
  `DESIGN.md`; its tables are covered by the #408 freshness lint)
- Outcome: pending merge.

## 2026-10-04 — cms-platform/aws-bootstrap — edit

- Motivation: the #408 freshness lint found `DependsOn` cited as the
  CloudFront-on-certificate ordering; the template dropped it as redundant
  (cfn-lint W3005).
- Change: the troubleshooting step now names the implicit `!Ref` dependency
  (PR #563).
- Eval: exempt (DESIGN.md non-coverage table)
- Outcome: pending merge.

## 2026-10-04 — cms-platform/aws-bootstrap — edit

- Motivation: the bootstrap template outgrew the CLI's 51,200-byte inline limit, so a redeploy failed until `deploy.sh` uploaded it through S3; the skill described the old inline deploy.
- Change: the skill now documents `TEMPLATE_S3_BUCKET` (first deploy of a new stack only), the S3 upload step, and the `Templates with a size greater than 51,200 bytes` error (https://github.com/Adam-S-Daniel/cms-platform/pull/566).
- Eval: exempt (DESIGN.md non-coverage table)
- Outcome: merged 2026-10-04.

## 2026-10-04 — cms-platform/platform-release-and-bump — edit

- Motivation: AGENTS.md was shrunk under a size budget and the "Delegated mechanical work is done when a VERIFIER exits 0" section moved out of it, so the skill's pointer named a heading that no longer existed there.
- Change: the delegation pointer now names `docs/CONTRIBUTING.md` instead of AGENTS.md (https://github.com/Adam-S-Daniel/cms-platform/pull/556).
- Eval: none — no eval exists yet
- Outcome: merged 2026-10-04.
