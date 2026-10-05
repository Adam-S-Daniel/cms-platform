# skill-impact.md — the cms-platform bundle's skill-change audit trail

Every change to a skill under `skills/` (the `cms-platform` bundle) gets an
entry here — creations, edits, renames, removals, and **rejected proposals**.
The rejected ones are the reason the file exists: git history records what
landed, but nothing records what was tried and turned down, so the next
session re-derives and re-proposes it. An approach already ruled out is the
expensive thing to lose. (Convention defined in skills-evals' `DESIGN.md`,
"Scaling to the registry", and copied from adam-agentskills'
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

## 2026-10-05 — cms-platform/ci-watcher-loops — edit

- Motivation: in skills-evals ci-watcher-loops rounds 3 and 4 (https://github.com/Adam-S-Daniel/skills-evals/issues/89#issuecomment-5997263591, https://github.com/Adam-S-Daniel/skills-evals/issues/89#issuecomment-5998102731), with-skill trials discarded `gh workflow run`'s output and found the run with `gh run list --limit 1` (3 of 3 in round 4, 0 of 3 without the skill): an extra read, and a race that can pick another actor's run of the same workflow.
- Change: "The fix" and the multi-step example take the run id from the run URL `gh workflow run` prints (gh >= 2.87.0, https://github.com/cli/cli/releases/tag/v2.87.0); `gh run list` is only a fallback when no URL is printed, filtered by workflow, `workflow_dispatch` event, branch, dispatching user and a created-after timestamp, and accepting a single match only. "What NOT to do" drops "always poll `gh run list --limit 1`".
- Eval: skills-evals ci-watcher-loops touch gate, fixture skills-evals main 901cca7 (two follow-up turns, https://github.com/Adam-S-Daniel/skills-evals/pull/286), skill at 6b4d338, local, 3 trials per arm, 0 errors: objective 8.0 vs 8.0 of 8 with vs without (all eight checks 3/3 in both arms), judge 8.32 vs 7.85; `gh run list` discovery after the dispatch 0/3 with the skill (round 4: 3/3). PASS (https://github.com/Adam-S-Daniel/cms-platform/pull/680#issuecomment-5998770991). The fixture's fake `gh workflow run` prints a JSON object, not a bare URL line, so neither the URL-parse branch nor the filtered fallback was exercised: the agents read the id from the dispatch JSON. That fixture defect is since fixed (https://github.com/Adam-S-Daniel/skills-evals/pull/290, the fake now prints the run URL a real gh prints), but the eval was not re-run against it.
- Outcome: merged 2026-10-05 (https://github.com/Adam-S-Daniel/cms-platform/pull/680, dc5a643b).

## 2026-10-05 — cms-platform/code-quality — edit

- Motivation: in the skills-evals code-quality eval (issue #88 slice: add Go; https://github.com/Adam-S-Daniel/skills-evals/issues/88), all 3 with-skill trials wrote a golangci-lint v1 config (top-level `linters-settings`, no `version: "2"`) that is not the v2 schema, so golangci-width-100 scored 0/3 with the skill against 2/3 without.
- Change: "Adding a new language" step 2 gains one short clause: for golangci-lint write a v2 config (`version: "2"`, settings under `linters.settings`). Shape per https://golangci-lint.run/docs/configuration/file/; `golangci-lint migrate` converts a v1 file (https://golangci-lint.run/docs/product/migration-guide/). A first, longer wording (step 2 told the agent to use the tool's current schema, also named gofmt/goimports under `formatters`, and carried the doc links inline) is superseded by this one: see the Eval line.
- Eval: skills-evals code-quality, skills-evals c9562cf (auto-memory off, judge and arms isolated, tree-sitter pinned), 6 trials per arm, 0 errors. Deciding result, narrow wording (new a1e0d40) against the old skill (d54bace) and no skill (two runs): golangci-width-100 new 6/6, old 3/6, no skill 3/6 and 2/6; hook-guards-go-tools 4/6, 3/6, 3/6 and 4/6; hook-lints-staged-go 4/6, 3/6, 3/6 and 2/6; objective 9.33, 8.50, 8.33 and 8.33; judge 7.13, 6.05, 5.77 and 5.78. The old skill's earlier non-isolated 6/6 on both hook checks did not repeat (3/6 isolated), so the hook-check drop seen with the first wording is not reproduced by the narrow one. Earlier, non-isolated history (skills-evals 1abf4ff, judge not isolated): baseline d54bace, 3 trials per arm, with_skill objective 9.0/10 vs without_skill 7.67/10 after re-scoring (raw 8.0 was a `parser_unavailable` scorer artifact), judge 6.57 vs 5.70 indicative only. 6-trial table for the first, longer wording (https://github.com/Adam-S-Daniel/cms-platform/pull/623): golangci-width-100 new 5/6, old skill 2/6, no skill 6/9; hook-guards-go-tools new 2/6, old 6/6, no skill 5/9; hook-lints-staged-go new 2/6, old 6/6, no skill 6/9. The targeted check was fixed but both hook checks fell 6/6 to 2/6, so the wording was narrowed to the single clause above; the isolated re-run supersedes that table.
- Outcome: pending merge.

## 2026-10-05 — cms-platform/cms-stuck-pr-triage — edit

- Motivation: in the skills-evals cms-stuck-pr-triage eval, all 3 with-skill trials called a green-but-BLOCKED PR a merge-state caching bug and never named the required context no workflow publishes (both scored without-skill trials did), and 2 of 3 recommended closing an editor's `decap-cms/pending_publish` PR.
- Change: §3 now diffs the ruleset/branch-protection required contexts against the head sha's reported check runs and statuses, then looks for a context withdrawn by a skipped caller job (cms-platform#222), before any caching diagnosis; §1c and §4 point there; §4 closes a stale `pending_publish` PR only when the loop owns it (`automated-test` label or the unpublish-canary branch).
- Eval: skills-evals cms-stuck-pr-triage, local eval against this branch's ac3470a snapshot (skills-evals a41dfb0), 3 trials per arm, trial 3 timed out in both arms (runner), so 2 scored per arm and the run reports "completed with errors". with_skill objective 6.0/7 (pr-b-missing-required-context-named 2/2, pr-c-left-alone 2/2, no-write-attempted 2/2); without_skill 4.0/7 (pr-b 2/2, pr-c-left-alone 0/2, no-write-attempted 0/2); judge 9.6 vs 9.6 (with_skill n=1 after one judge error, without_skill n=2). loop-log-was-read 0/2 in both arms is a fixture-level check issue, not this change.
- Outcome: pending merge.

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

## 2026-10-05 — cms-platform/code-quality — edit

- Motivation: a prompt audit found the "What actually runs" callout citing an AGENTS.md "Deliberate skips" list and a "Code quality" section that do not exist, and a lint count (~101) that no longer matches (e2e has 190 test files minus the DENY list).
- Change: the callout drops the dangling AGENTS.md references and the lint count, and step 4 of "Adding a new language" says to document in this skill.
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-05 — cms-platform/browser-testing — edit

- Motivation: a prompt audit found "~25 specs" where e2e holds 74 `*.spec.js` files.
- Change: the matrix sentence no longer quotes a spec count.
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-05 — cms-platform/ci-watcher-loops — edit

- Motivation: the Reference section pointed at a per-machine agent-memory file that exists on one workstation only, against AGENTS.md's "record knowledge in the repo, not agent memory".
- Change: the memory pointer is removed; the 2026-05-06 incident line and the chained-capture rule above it stay.
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-05 — cms-platform/platform-release-and-bump — edit

- Motivation: a prompt audit found a dated ref count (32 `@v0.1.88` refs) and a v0.1.76 bullet written as if the next bump carried the 9-caller `edited` edit; both consumers are at v0.1.130.
- Change: the ref count is replaced by a re-check at v0.1.130 without a number, and the bullet states the current rule (callers omit `edited`; `deploy-preview.yml` keeps `closed`).
- Eval: none — no eval exists yet
- Outcome: pending merge.

## 2026-10-05 — cms-platform/github-actions-sha-pinning — edit

- Motivation: the consumer-scope paragraph quoted "32 apiece at v0.1.85"; each consumer now has 36 platform refs at v0.1.130.
- Change: the paragraph drops the count.
- Eval: a skills-evals fixture exists for this skill; not run here, outstanding for the touch gate
- Outcome: pending merge.

## 2026-10-05 — cms-platform/consumer-repo-provisioning — edit

- Motivation: a prompt audit flagged ~60 lines on `CMS_PLATFORM_PAT` "for repos on an older pin"; both consumers are on v0.1.130 and the PAT section carried a stale "hard-needs this PAT" line and a PAT permission table.
- Change: the section keeps the removal rule and the 2026-09-02 / 2026-08-20 dated facts, drops the PAT permission table, owner note and older-pin framing; the freshness allow-list marker follows the new heading.
- Eval: a skills-evals fixture exists for this skill; not run here, outstanding for the touch gate
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
