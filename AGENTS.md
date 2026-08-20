<!-- BEGIN MANAGED SECTION — DO NOT EDIT ABOVE "## Repo-specific additions" -->
<!-- Source: _agent-guidance -->
<!-- Sections: none -->

# AGENTS.md

> **Managed by [`_agent-guidance`].**
> Edit only below the `## Repo-specific additions` header.
> Everything above it will be overwritten on the next sync.

This block is deliberately short. It carries the things that are **specific to
this account and learned the hard way** — incidents, fleet policy, machine
layout. It does not restate general engineering practice, and it does not
describe anything you can learn by reading the repo. Depth lives in each repo's
`docs/` and in the skills registry; follow the pointers when the work touches
that area.

## Working in these repos

- Fix what was asked. No speculative features, premature abstractions, or
  unused helpers.
- Prefer editing an existing file over creating a new one.
- Every public interface change updates the corresponding tests.
- Run the existing test suite before calling a task complete, and say plainly
  what you ran. New behaviour gets a test; a bug fix gets a regression test.
- Tests must be deterministic — no sleeps, no network, no reliance on
  wall-clock time.

## Finding your unknowns

Output quality on a non-trivial task is bounded by how well the ambiguities got
resolved — and most of them surface *during* implementation, not before it. So
treat unknown-hunting as part of the work, not a phase that ends at the plan:

- Before building: name what you don't know. Prefer a reference in **code** — an
  existing implementation to mirror, a failing test, a rubric, an HTML mockup —
  over a prose description of the same thing.
- While building: keep a running note of decisions that departed from the plan
  and edge cases you hit. Surface them; don't silently absorb them.
- After building: be able to explain what changed and why it is correct.
- Durable findings go in the **repo**, not in agent memory — an environment
  quirk, non-obvious wiring, where a source of truth actually lives, a
  sequencing constraint. Repo files version with the code and every person and
  every harness that opens the repo sees them; agent memory is per-agent and is
  silently missed by the next session. A fleet-wide rule goes in
  `_agent-guidance`'s `agents-md/base.md`, a repo fact below the
  `## Repo-specific additions` marker, a reusable procedure into the skills
  registry. A memory note is a supplement, never the only copy.

The full workflow (blind-spot pass, self-interview, implementation notes,
post-hoc explainer) is the **`finding-unknowns`** skill in the registry. Reach
for it on unfamiliar code, a new domain, or anything with subjective acceptance
criteria.

## Workstation layout

Repo locations are host-specific — match the convention of the machine you're on
(on Windows, check `$env:COMPUTERNAME`).

- **`ZENDA`** (Windows): local clones live under `D:\repos\<github-owner-or-org>\<repo>`
  (for example `D:\repos\adam-s-daniel\wsl-automation`). Clone new repos there, and
  assume existing repos live there rather than under the user profile
  (`C:\Users\<user>\...`).

## Sessions get cut off

**`ZENDA` drops sessions mid-task, frequently.** Assume any run can end between
one tool call and the next, and keep the work recoverable throughout rather
than only at the end.

- **Commit and push as you go**, on a branch. A pushed branch survives the
  laptop; the conversation, a dirty tree and a worktree do not — a worktree can
  be deleted with the session that made it. Small commits *are* the checkpoint.
- **Persist the expensive part**, which is the investigation and not the diff:
  the root cause, the baseline test result, the option already ruled out. A
  fresh session can regenerate a patch quickly; it cannot cheaply re-derive why
  the obvious fix was wrong. Put it in the commit message, the PR body, or an
  ADR — all of which outlive the context window. Chat does not.
- **Say where things stand before a long step** — a full test suite, a CI
  watch, a wide refactor — so a resumed session starts from a statement of what
  is done and what is next, not a reconstruction of it.
- **Report a resume pointer, not just an outcome:** branch, PR number, worktree
  path, and the next command to run.

## Security

Standard practice applies without being restated here. These are the ones with
teeth in this account:

- Validate anything that crosses a trust boundary — user input, API responses,
  file contents.
- Never build SQL, shell commands, or HTML by string-concatenating untrusted
  data. Use parameterized queries, shell arrays, and context-aware escaping.
- Never commit secrets, credentials, or `.env` files.
- Never disable TLS verification, authentication, or CSRF protection.

## Data exposure in CI and public repos

Treat CI run logs, job summaries, artifacts, workflow run pages, and git history
as **public** on a public repo. (Real incident: a workflow printed the owner's
email addresses and their correspondents' into a public Actions log.)

- **Never print personal or sensitive data to a log** — no emails, contacts,
  names, IDs, mailbox sizes/counts, tokens, or anything "useful to an attacker or
  scammer." Deliver sensitive results out-of-band (e.g. email the account itself,
  write to a private store) and log only a non-identifying status line.
- **Don't interpolate `${{ inputs.* }}` / `${{ github.event.* }}` into a `run:`
  block** — the rendered command is echoed to the log. Read inputs from
  `$GITHUB_EVENT_PATH` inside the script and `::add-mask::` sensitive values
  before use. `::add-mask::` only scrubs the log *stream*, not other surfaces.
- **Put sensitive config in secrets, not plaintext inputs or `vars`.** Only
  secret *values* are masked in logs.
- **Sanitize error output** — never dump an API/HTTP response body on failure (it
  can quote personal data); reduce it to a status code + machine error type, and
  keep the data-bearing serialization/call inside the try/catch.
- **Least privilege:** set `permissions:` to the minimum (usually
  `contents: read`) and require approval for outside-collaborator fork PRs.
- **Test fixtures use reserved `example.com` / `example.net` domains only** —
  never a real address; fixtures get committed and logged.

### git history & metadata
- **Sanitize before the first commit.** Fixing the current file does not remove
  data from history. If sensitive data was committed, rewrite history to drop the
  commits, delete every ref that points at them (branches, tags, **PRs**), and
  force-push. GitHub garbage-collects unreachable objects on its own schedule
  (days to weeks) — until then they remain reachable *by SHA* — and you can ask
  GitHub Support to expedite for a public repo. (This is the deliberate exception
  to "don't force-push"; it is a security remediation.)
- **Commit with the GitHub `…@users.noreply.github.com` identity** on public
  repos so a real email is not baked into commit author/committer metadata.

## Automation vs branch protection

Fleet repos enforce PR-only default branches via ruleset, managed as code in
`repo-settings` (see its ADR 0001). Design automation accordingly:

- Never design a bot that pushes to a protected default branch ad hoc — the
  push is rejected (GH013), even from the repo's own workflows.
- Generated data (badges, run summaries, reports, dashboards) belongs on a
  dedicated unprotected results branch (e.g. skills-evals' `eval-results`);
  consumers read from that branch and treat its content as untrusted.
- The rare bot that genuinely must write to a default branch needs a ruleset
  bypass actor declared in repo-settings' `fleet.yml` — never a hand-granted
  UI bypass (the drift report flags those). The AGENTS.md sync App is the
  standing example.
- PR + auto-merge is not a sanctioned bot-write path for fleet repos; the
  cms-platform-managed repos (outside the fleet ruleset) use it by their own
  design.

### A required status check gets no `concurrency` group

A job that publishes a **required** status context and can fire more than once
on the same head sha — label events, an `opened` + `synchronize` burst, any
multi-event trigger — gets no `concurrency` block at all.

- GitHub picks **non-deterministically** between a cancelled run and a
  successful one for the same context + sha. When cancelled wins the PR is hard
  blocked: the merge API returns `405 Required status check "<ctx>" is
  cancelled`, and nothing overrides it — not native auto-merge, not an explicit
  merge call, not a nudge bot. The PR looks all-green and simply never lands.
- **`cancel-in-progress: false` is not "run them all."** GitHub keeps the
  in-progress run plus only the *latest* pending run in the group and cancels
  the other pending duplicates, so a same-sha burst still leaves cancelled runs
  behind. Flipping that flag is the fix that looks right and changes nothing.
- Same mechanic on any shared lane: when one push drives two workflows into one
  group, the older pending sibling is cancelled. Make the triggers pairwise
  disjoint — a shared group only serialises runs that already arrive apart.
- Jobs triggered only by `push` / `synchronize` — each a new sha — are safe to
  cancel and keep `cancel-in-progress: true`.
- Lock the invariant with a test that **parses** the workflow YAML (the `yaml`
  package — never a regex or line scan, which reads clean on text it cannot
  see), so the block cannot come back.

## Two GitHub connectors, and which one you are holding

A session here can see **two** GitHub MCP servers at once. They authenticate as
the same person, so `get_me` will not tell them apart, and the tool names do
not say which is which. Establish it before you reach for one:

- **`mcp__github__*` — session-provisioned.** It does NOT appear in
  `ListConnectors`; the remote environment supplies it and the session's own
  system prompt points at it. It is the **only** one with GitHub Actions tools
  (`actions_list`, `actions_get`, `actions_run_trigger`), CI introspection
  (`get_check_run`, `get_job_logs`), auto-merge control, and review-thread
  resolution. Its reach is the session's attached repositories; `add_repo`
  widens it mid-session.
- **`mcp__b26ebb34-…__*` — the claude.ai org connector `github-mcp`.** It lists
  in `ListConnectors` as `connected: true`. Its tool set is a **strict subset**
  of the above: same reads, same PR and issue writes, same `merge_pull_request`,
  `push_files` and `delete_file` — and no Actions, no job logs, no auto-merge,
  no review threads. Its reach comes from a GitHub App installation allowlist
  that is INDEPENDENT of the session's attached repos.

Three consequences, and the first is why this section sits where it does:

- **Everything that verifies CI is `mcp__github__`-only.** Dispatching a run,
  reading a rollup, pulling a failed job's log — the org connector can do none
  of it. A session holding only `github-mcp` cannot follow the rule below at
  all: it can merge a pull request but it cannot check one.
- **Fewer tools is not less dangerous.** Both connectors merge, push and
  delete. The subset one is the connector whose reach you cannot infer from the
  session's repo list, so a write through it can land somewhere the session was
  never scoped to. Measured 2026-08-19: `github-mcp` 404s on the private
  `repo-settings` even though the account can push there, while both read a
  public non-attached repo fine.
- **A 404 means "not visible to THIS connector"** — never that a repo or file
  does not exist. Re-check on the other one before concluding anything; the
  next section is how to tell the two apart.

Prefer `mcp__github__` for everything. Reach for `github-mcp` only when the
other genuinely cannot see a repo, and say so out loud when you do. When you
report a verification, name the connector it came from.

## A GitHub 404 means "not authorized", not "not there"

GitHub answers **404 rather than 403** when a caller is not authorized to know a
private repo exists — it will not confirm the repo either way. So a 404 from any
GitHub API or MCP call is ambiguous by design: either the thing is gone, or the
credential simply lacks that repo. The body says "Not Found" in both cases,
which is why the wrong reading — telling someone their PR was deleted — is the
easy one to reach for.

- **Probe the repo, not the object.** If `GET /repos/<owner>/<repo>/pulls` 404s
  as well, the whole repo is invisible to that credential: a scope gap, not a
  missing PR. If the repo answers and only the object 404s, it is genuinely
  gone.
- **Try the other connector before concluding anything.** The two servers above
  do not share an installation, so one can be blind to a repo the other reads
  fine. (Real incident, 2026-08-19: a mid-session MCP reconnect brought up a
  second GitHub server whose credential could not see a private repo. Every call
  against it 404ed — including on a PR the *other* connector had read
  successfully minutes earlier — and the repo was neither deleted nor unshared.
  `add_repo` reported it already attached, which is about session scope and does
  not widen a connector's own installation.)
- **Git is a separate credential path** and often still works when the API
  token does not. `git ls-remote origin '<ref>'` answers "does this branch
  exist"; `git merge-base --is-ancestor <sha> origin/main` answers "was it
  merged". Neither touches the API, so both stay available to report real state
  while a connector is blind.
- Never report a repo, PR, or branch as gone on a 404 alone. Say which
  credential could not see it, and what you checked with.

## "The watch finished" is not "CI passed"

Never read CI pass/fail off a watch command's exit code, or off the fact that it
returned. Three failure modes stack: in `cmd | tail` the shell's `$?` is
`tail`'s — always 0 — masking the non-zero from `gh pr checks`; a backgrounded
watch reports that same pipeline code, so its "completed (exit code 0)"
notification says nothing about the build; and `tail -N` can show only the
passing and skipping lines while the FAILURE lines scrolled out of the window,
so eyeballing it looks green too. (Real incident: all three lined up on one PR —
e2e and lint were FAILURE while the session reported CI green and moved on.)

- Capture the real code with `${PIPESTATUS[0]}`, or don't pipe the watch at all.
- After **any** CI watch, query the conclusions explicitly and report the parsed
  result before acting on it:

  ```bash
  gh pr view <n> --repo <owner>/<repo> --json statusCheckRollup --jq \
    '.statusCheckRollup[] | (.conclusion // .state) as $c
     | select($c != null and $c != "SUCCESS" and $c != "NEUTRAL")
     | "\(.name // .context): \($c)"'
  ```

  A check run carries `.conclusion`, a legacy commit status carries `.state` —
  filter on only one and the other's failures read as clean.
- Treat "watch done" as "now verify", never as "passed". Don't launch a watch
  and go passive without a definite verify-the-rollup step on resume.

## Dependency updates

Dependabot runs with a **minimum package age** (`cooldown`) so an unattended
merge still gets a cooling-off period: `default-days: 7`, `semver-major-days: 30`.
Two things about that setting are easy to get wrong:

- It applies to **version** updates only. A security advisory bypasses cooldown
  entirely and opens immediately — the wait never delays a vulnerability fix.
- An unset `cooldown` is **not** "no wait": GitHub applies an implicit 3-day
  minimum age to version updates. Writing 7 is a raise from 3, not from zero.

`semver-minor-days` / `semver-patch-days` are deliberately left undefined —
they fall back to `default-days`, and spelling them out only invites drift.

The window is not only Dependabot's. A package you add or bump **by hand** mid-task
is the case with no automation watching it: check the publish date
(`npm view <pkg> time --json`), take the newest release that has already cleared
the 7 days rather than the freshest one, and pin it exact (no caret) so `npm ci`
cannot drift onto a version that has had no cooling-off at all.

## A name you choose becomes data a scanner reads

gitleaks' `generic-api-key` rule fires on a **keyword** next to a
high-entropy value. The keyword list is short and ordinary:

```
access  auth  api  credential  creds  key  passwd  password  secret  token
```

Nothing warns you that those words are reserved, because they are not — they
are only reserved *in the position a scanner looks at*. Name a skill, a config
key, a job output, an artifact or a fixture with one of them, and every
generated file that serialises `name: value` alongside a hash, id or digest
starts looking like a leak.

That is not hypothetical. A skill named **`cms-platform-secrets`** put the line
`"cms-platform/cms-platform-secrets": "<64-hex>"` into `skills.lock`, which is
generated, committed, and scanned. Both consumer sites went red on every push
to `main` — adamdaniel.ai for eight consecutive pushes, each one a blocked
editorial publish. An audit of all 34 skill names across both registries found
exactly one hit: that name. One word, one outage.

The shape that makes it hard to catch:

- **The repo that chooses the name is not the repo that breaks.** cms-platform
  named the skill; the two sites that install its bundle are what went red.
  cms-platform's own lock lists only `adam/*` skills, so it stayed green and
  the author had no signal at all.
- **A pull request cannot see it.** The PR lane scans `base..head`; the push,
  schedule and dispatch lanes scan full history. A finding that lives in an
  older commit is invisible to every PR and fires on every push.
- **History is immutable, so the name outlives the rename.** Fixing the
  generator or renaming the skill fixes the working tree and nothing else. The
  old line stays in every clone until history is rewritten.

So:

- **Check a name against that list before you commit to it**, whenever the name
  will land in a generated or serialised artifact. It costs one grep. Prefer a
  name that says what the thing is for over one that names the sensitive noun —
  `consumer-repo-provisioning` carries the same meaning as
  `cms-platform-secrets` and trips nothing.
- **Fix it at the source, not with an allowlist.** An allowlist entry is
  per-repo; a `.gitleaksignore` fingerprint is `<commit>:<file>:<rule>:<line>`
  and commit shas are repo-unique, so it cannot be propagated *at all* — copied
  to another repo it names a commit that does not exist there and silently
  suppresses nothing while looking like coverage. One rename immunises every
  consumer at once; N exclusions immunise N repos until the next one adopts.
- **Do not lean on a scanner's internals.** Labelling a digest `sha256:<hex>`
  currently dodges the rule because `:` falls outside its capture class — a
  welcome side effect, and a bad thing to depend on. Justify such a label as
  self-documentation (it says which algorithm produced the digest); if the
  upstream regex ever widens, every lock in the fleet goes red at once.
- **Suppress by value, never by path.** A `paths` entry does not filter
  findings, it skips the file before any rule runs, so a real credential pasted
  into it is never reported (cms-platform#260 — 29KB of a public repo left
  unscanned that way, suppressing nothing that the value regexes did not
  already cover).

## Pinning GitHub Actions

**Every `uses:` is pinned to a full 40-character commit SHA** — in workflows,
composite actions, and reusable-workflow references alike. The one carve-out,
named below, is a ref into this account's own `cms-platform`, and it covers both
of the shapes such a ref takes. Never a tag, never a branch, never an
abbreviated SHA. A tag is a movable pointer: pinning to one gives whoever can
retag the upstream repo a shell on the runner, holding that job's token.

```yaml
uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11
```

- **A pin carries NO trailing version comment.** `@<sha>` and nothing after it.
  The argument for one is intuitive and will be re-derived by the next person, so
  here is why it lost: forty hex characters do say nothing on their own, but the
  comment is not maintained by anything, and an unmaintained label does not stay
  silent — it starts lying. Dependabot's rewriting of it is **inconsistent**, not
  merely incomplete: measured 2026-08-20, it rewrote a bare `# v5` to `# v7.0.0`
  in GHA-bench#52 while leaving `# v4` stale on the line above **in the same
  file**, and it left every `# vX.Y.Z (YYYY-MM-DD)` comment untouched in
  skills-evals #38/#39/#40 while moving their SHAs. The result in one repo:
  `actions/checkout` at v7.0.1 labelled `# v4.3.1` in one file and `# v6.0.0` in
  two others. A wrong label is worse than no label, because it is read and
  believed — a reviewer trusts it instead of resolving the SHA, and the
  staleness the comment was supposed to advertise is exactly what it hides. The
  SHA is the truth. When you need the version, resolve it:
  `git ls-remote <url> | grep <sha>`, or read the Dependabot PR title.
- **Wait 7 days after a release before adopting it** — the cooling-off above,
  applied by hand. If the newest release is younger than that, pin the previous
  one.
- **Dereference annotated tags.** `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`
  returning `.object.type == "tag"` gives you the tag object's SHA, not the
  commit's, and pinning that fails at runtime. Follow it with
  `git/tags/<that-sha>`, or ask git directly:
  `git ls-remote <url> 'refs/tags/<tag>^{}'`.
- **The one carve-out: a ref into `cms-platform` — a repo this account owns —
  stays on a tag, in either shape that ref takes.** Both of these are correct as
  written, and neither is a SHA-pinning violation to be "fixed" — a reusable
  **workflow**, `Adam-S-Daniel/cms-platform/.github/workflows/<x>.yml@v0.1.88`,
  and a **composite action** referenced from another repo,
  `Adam-S-Daniel/cms-platform/.github/actions/<x>@v0.1.88`. The tag is the
  platform's release identity: `platform-bump.yml` moves the `uses:@` refs, the
  theme gem, `platform.lock` and every `platform_ref:` input to one release in a
  single PR, and `check-platform-pin-consistency.js` asserts each of those refs
  equals `platform.lock`'s `platform_ref` — a SHA in either shape fails that lint
  and strands the bump. The composite shape used to be the exception to the
  exception, pinned by SHA plus a `# vX.Y.Z` comment; that comment was the only
  thing tying such a pin to `platform_ref`, and with the comment gone the tag is
  what ties it. It stops there — nothing third-party is ever a tag, in either
  shape.
- `./local/path` and `docker://` refs have nothing to pin. Leave them.

`sha_pinning_required: true` enforces the rule at the repo level — set by
`repo-settings`' `fleet.yml` for the fleet and `cms-platform`'s
`repo-settings.yml` for the three sites it manages. It governs **actions**, not
reusable-workflow refs: adamdaniel.ai and jodidaniel.com were already enforcing
it at the 2026-07-13 audit and still call 32 tag-pinned cms-platform reusables
apiece, and four repos on the `fleet.yml` default call one each. That is what
makes the carve-out workable — and what leaves a tag in a *third-party* reusable
ref for review, not the setting, to catch.

## Subagent delegation (model routing)

- Don't write code in the main loop: run the implementation in a subagent on an
  appropriately lower-power model (e.g. the Agent tool's `model` override in
  Claude Code; skip if the harness has no subagent support).
- Route by mechanicalness: smallest model (haiku-class) for exactly-specified
  edits — pin bumps, renames, config/doc tweaks; mid-tier (sonnet-class) for
  normal implementation from a clear spec. Escalate rather than ship a wrong
  diff when the task is genuinely subtle (cross-repo invariants, race
  conditions).
- The main loop keeps root-cause investigation, architectural decisions,
  writing the spec, and review of the subagent's diff before commit.
- Delegated work is done when a **verifier exits 0**, not when the report reads
  as finished. Name the exact command in the spec and require its exit code
  back. A subagent that cannot run it reports BLOCKED; a count that disagrees
  with the spec's stated expectation is a stop-and-report condition, never a
  rounding difference.
- Don't assume the subagent sees this file: general-purpose and custom
  subagents receive the full memory hierarchy (imports included), but
  Explore/Plan-type agents and SDK harnesses with `settingSources: []` skip
  repo guidance entirely. Restate load-bearing constraints (style, test
  command, invariants) in the delegation prompt, and don't hand
  guidance-sensitive work to agents that won't see it.
- **Any prompt that sends a subagent to live-test states the credential
  boundary** — which `HOME`/profile it may use, what it may read, and that it
  must not copy real credentials anywhere to make the test pass. (Real
  incident: a reviewer live-testing a plugin migration in a scratch `HOME`
  copied the account's real OAuth credentials into it. The test worked; nobody
  had asked, and nothing in the prompt forbade it.)
- Supply a throwaway credential, or scope the test to what runs
  unauthenticated. If it genuinely cannot run without a real one, that is the
  operator's call — not a gap for the subagent to close on its own initiative.

## Skills ecosystem

- The canonical skills registry is `github.com/Adam-S-Daniel/agentskills`,
  organized as three bundle plugins — `adam` (general-purpose, cloud-safe;
  default-on), `adam-local` (machine-bound), and `fastmail` — each holding
  `skills/<skill>/` directories.
- In Claude Code with the marketplace installed, invoke a skill as
  `/adam:<skill>` (e.g. `/adam:finding-unknowns`).
- Local machines get the marketplace plus per-agent symlinks via that repo's
  `setup.sh`.
- Cloud/ephemeral sessions still get **no** plugins from repo-declared
  settings — that Claude Code limitation (agentskills' `docs/decisions/0001`)
  is unchanged. What changed is that it now has a fix: a repo carrying its own
  `skills.lock` plus the `skills-bootstrap` SessionStart hook installs the
  bundles that lock names directly into those sessions, verified against a
  pinned commit and per-skill digests. Such a session opens with a `skills:`
  verdict naming what loaded, or why nothing did — read it instead of guessing.
- **Adoption is opt-in and double-keyed, and no longer rare.** Delivery needs
  an allowlist entry in `_agent-guidance`'s `repos.yml` AND a `skills.lock` the
  repo committed itself — the fleet sync never writes one, because the lock is
  where a repo declares which bundles it installs (some federate several
  registries). A repo holds both keys, or is mid-adoption holding one, or is
  deliberately out for a reason — a propagation experiment the bundle would
  contaminate, a dormant repo whose sessions never happen. Which of the three
  fits an unfamiliar repo is not guessable: look for `skills.lock`. Bundles
  cost always-on context in every session that carries them, which is why this
  stays a deliberate per-repo decision and not a fleet default.
- New reusable skills graduate **into** the registry (sensitive ones into
  `agentskills-private`) rather than living on in a consumer repo. A long skill
  splits across files rather than growing into one wall of text.

## Git practices

- Write concise commit messages that explain *why*, not just *what*.
- One logical change per commit.
- Do not amend published commits or force-push shared branches.
- **Merge with a merge commit — `gh pr merge --merge`.** Squash and rebase are
  disabled on every fleet repo, so `--squash` fails rather than falling back;
  do not try it, and do not offer it as a choice. The exceptions are the three
  cms-platform-managed repos (`cms-platform`, `adamdaniel.ai`,
  `jodidaniel.com`), where squash stays enabled because the Decap publish chain
  arms SQUASH auto-merge on every editorial PR and squash is what collapses an
  editor's many per-save commits into one `publish: <title>` commit. Merge
  commits work there too, so `--merge` is the one form that works everywhere.

  Squash is off elsewhere because it is actively unsafe for a repo that pins
  commits by sha: it collapses a branch into a new commit and strands the
  originals on no branch, so a lockfile naming the pre-merge content commit
  (agentskills' `skills.lock`) ends up pinning something a fresh clone of the
  default branch does not contain. Measured on throwaway clones 2026-08-15 —
  `generate_skills_lock.py --check` then fails with `cannot resolve ref`.
  Settings are enforced as code: `repo-settings`' `fleet.yml` for the fleet,
  `cms-platform`'s `repo-settings.yml` for the three above.

<!-- END MANAGED SECTION -->
## Repo-specific additions

# AGENTS.md — working in cms-platform

Reusable CMS machinery extracted from **adamdaniel.ai**, so new sites get the
same Jekyll + Decap + AWS stack and platform improvements sync **both ways**.
Read this before changing anything here. Design: `docs/ARCHITECTURE.md`. Sync
model: `docs/SYNC.md`.

**Current release: `v0.1.88`** — `v0.1.0`–`v0.1.88` are all tagged GitHub
releases; cut a new one with `gh workflow run release.yml -f version=vX.Y.Z`.
That number is also carried by the two plugin manifests (`plugin.json` +
`.claude-plugin/plugin.json`), and `release.yml` REFUSES to cut a tag whose
version disagrees with them — so bumping this line, both manifests, the
`docs/VERSION-HISTORY.md` entry, **every platform pin under
`examples/site/.github/workflows`** (each `uses:@ref` and each
`with: platform_ref:`) and **`scaffold/create-site.js`'s `PLATFORM_VERSION`**
is ONE atomic edit made in the release PR, before the dispatch.

Those last two are not bookkeeping. `e2e/examples-site-pins-current.test.js`
enforces them in the REQUIRED node-unit-lints lane, so a tag cut without them
reds self-CI the moment it lands. That lint compares in-repo values only and
never resolves the tag, which is exactly what lets the release PR go green
*before* the tag exists. This paragraph and `release.yml`'s manifest-skew error
string are the only two places the edit set is written down — keep them in step.

Consumers: **adamdaniel.ai** (consumer #1, dogfood; gem-delivered admin live on
prod) and **jodidaniel.com** (consumer #2; single-page bio, gem admin + 9
per-section collections, `base_collections: []`, gated coming-soon). See
"Admin delivery (gem-shipped, v0.1.4+)", "Version history", and "Roadmap /
open issues" below.

## The model

Two repos. **This repo owns all machinery** (versioned, semver tags). A **site
repo** holds only content + identity (`_config.yml`) + thin consumers. Site
content/branding/docs **never** sync; platform/infra/CI/tooling do (skills are
not synced at all — see "Skills ship as a marketplace bundle" below);
structural scaffolding (collection types) is opt-in via the SITE-owned seam
`admin/collections.site.yml`. The Decap admin UI itself ships **inside the
theme gem** (since v0.1.4) — consumers no longer vendor a byte-copy of `admin/`;
they keep only the seam. See "Admin delivery" below.

## Deeper references

Progressive disclosure: the sections below point into `docs/` for the deep
material (exact numbers, incident timelines, code shapes) instead of carrying
it inline. Skim this table, then follow a link when you're actually touching
that area.

| Doc | Read it when… |
|---|---|
| `docs/ARCHITECTURE.md` | you need the two-repo design (platform vs. site repo) explained end to end. |
| `docs/SYNC.md` | you're changing what syncs between the platform and a consumer, or debugging drift. |
| `docs/ADMIN-DELIVERY.md` | you're touching `theme/admin/`, either render path, `base_collections`, or the `field_library` `$ref` mechanism. |
| `docs/CONSUMER-COMPATIBILITY.md` | you're adding an e2e spec, chasing an org OAuth save failure, or touching admin-bundle parity. |
| `docs/PIN-CONSISTENCY.md` | you're changing the pin-consistency script or `platform-bump.yml`'s seeding logic. |
| `docs/CI-INVARIANTS.md` | you're touching a required-check job, a scheduled workflow, the local e2e webServer, or a real-prod loop. |
| `docs/E2E-PARALLELISM.md` | you're re-tuning e2e CI workers, sharding, or the browser-install step. |
| `docs/VERSION-HISTORY.md` | you need to know whether/when something was already fixed, or the full story behind a fact stated tersely elsewhere here. |

## Layout

Most top-level directories are self-explanatory from their names
(`.github/workflows/`, `scripts/`, `infrastructure/`, `oauth-proxy/`,
`skills/`, `examples/site/`, `scaffold/`). The two rows below aren't:

| Path | Layer |
|---|---|
| `theme/` | the `cms-platform-theme` Jekyll **gem** (gemspec at `theme/`, so the gem root is `theme/`): layouts/includes/assets/plugins + the Decap render hook (`lib/cms-platform-theme/decap_config_hook.rb`) + the `admin/` UI |
| `theme/admin/` | Decap base config (`*.base.yml`) + admin JS/HTML/CSS (read `window.CMS_*`) + `reviews/` dashboards. Ships INSIDE the gem (since v0.1.4 — it had to move under `theme/` to be packaged); the render hook copies it into `_site/admin` and renders `config.yml`. Sites own only the seam `admin/collections.site.yml` (the gem ships no `collections.site.yml`). |
| `theme/spec/` | plain-ruby theme unit tests (`ruby theme/spec/<name>_test.rb`; no rspec/minitest dep beyond the stdlib `minitest/autorun` used by some); excluded from the gemspec `spec.files` glob |

See `docs/ADMIN-DELIVERY.md` for how the `theme/admin/` machinery gets from
the gem onto a consumer's live `/admin`.

## Conventions (do not break)

- **Port from `adamdaniel.ai@main`** — that's the source of truth. Don't invent;
  lift and parameterize.
- **Never hardcode `adamdaniel` identity.** Site values come from `_config.yml`
  (`cms.*`, `url`), workflow inputs, CFN params (`ResourcePrefix`,
  `ProductionDomainName`), `github.repository`, or injected `window.CMS_*`.
- **The /admin logo is SITE-OWNED; the gem ships only a NEUTRAL placeholder**
  (issue #25). `theme/assets/images/logo.svg` is a wordless, brand-free generic
  glyph — NEVER a specific site's mark (no "AD"/initials/wordmark). The render
  hooks default `cms.logo_url` to `<url>/assets/images/logo.svg`, and a site
  brands `/admin` by **shadowing** that gem asset with its own
  `assets/images/logo.svg` (Jekyll site files win over same-path gem files) or by
  setting `cms.logo_url`. The scaffolder seeds a "replace me" copy into every new
  site. Locked by `theme/spec/neutral_logo_test.rb` (gem asset is wordless +
  carries the override comment) and `e2e/scaffold-seeds-neutral-logo.test.js`
  (scaffold output). Don't reintroduce a brand into the gem asset.
- **The scaffolder seeds `preview.md` + `404.html` (issue #23).** A consuming
  site MUST expose `/preview/` (the admin "Live Preview" target) and a graceful
  `404.html`, or the admin button dead-ends on a raw S3 404 and unknown URLs 404
  ungracefully. The gem ships `theme/_layouts/preview.html` (the preview SHELL,
  with the hidden post/page/project variants the admin `preview-bridge` streams
  into) + the admin scripts, but the consuming site must provide the `/preview/`
  PAGE. `scaffold/create-site.js` seeds both (`SEED_PREVIEW` / `SEED_404`):
  `preview.md` is **front-matter only** (`layout: preview`, `permalink: /preview/`,
  `sitemap: false`) and carries **no front-matter `robots`** — the gem preview
  layout HARDCODES `<meta name="robots" content="noindex, nofollow">`, so a
  front-matter one would duplicate it (mirrors `adamdaniel.ai/preview.md`).
  `404.html` rides the gem `default` layout (which DOES render `page.robots`), so
  it carries `robots: "noindex,nofollow"` + `sitemap: false` + a home/blog link;
  copy is generic (no site identity). The `e2e/fixture-site` carries both (it
  represents a scaffolded site) and the platform lint
  `e2e/scaffold-preview-and-404.test.js` asserts the contract: (a) scaffold
  output, (b) fixture parity, (c) optional post-build proof that
  `_site/preview/index.html` renders the `data-preview-root` shell +
  `_site/404.html` exists (skips when no Jekyll toolchain — pure-fs self-CI
  lanes). **Single-page-site caveat:** per-item *live* preview is limited for a
  single-page bio (jodidaniel.com — no per-section route to drive the bridge);
  the seeded `preview.md` still gives a working `/preview/` shell + the seeded
  `404.html` a friendly not-found page.
- **Branch + PR, never push to `main`** (the auto-mode classifier enforces this).
- **Repo settings/rulesets change ONLY via a `repo-settings.yml` PR followed by
  a human `node scripts/audit-repo-settings.js --fix --yes`.** Emergency live
  flips must be ratified (PR the value in with a `# why:`) or reverted the same
  day — the daily `repo-settings-audit` workflow files a `ci` tracking issue on
  any drift.
- **Verify before claiming done** — run the render and the scaffolder against
  throwaway inputs; syntax-check YAML/bash/Ruby/JS. See "Verify" below.
- **Record knowledge here (AGENTS.md) and/or in `skills/`, not only in agent
  memory** — Adam's standing preference.
- **Two render paths stay in lockstep.** The live Decap config + `window.CMS_*`
  identity globals are produced by BOTH `scripts/render-decap-config.rb`
  (deploy-time) and the theme-gem Jekyll hook
  `theme/lib/cms-platform-theme/decap_config_hook.rb` (build-time — the path gem
  consumers use). Both must inject the same keys
  (`CMS_REPO`/`CMS_SITE_ORIGIN`/`CMS_APEX`/`CMS_OAUTH_BASE_URL`/`CMS_SITE_TITLE`)
  into the same shells (`admin/index*.html` + `admin/reviews/*.html`);
  `e2e/decap-config-render-parity.test.js` fails on drift. Admin chrome (titles,
  reviews dashboards) reads identity from these globals — never hardcode it.
- **`GITHUB_SCOPE` is lockstepped across three files** — `oauth-proxy/lambda.py`,
  `oauth-proxy/template.yaml`, `oauth-proxy/deploy.sh` (default `repo,user,workflow`).
- **De-identified prose uses placeholders:** `<apex>` (production apex), `*.<apex>`,
  `<prefix>` (apex with dots→hyphens), `<owner>/<repo>`, `<your-site>`.
- **Theme-gem ruby unit tests live in `theme/spec/`** (plain ruby — no rspec/minitest;
  `ruby theme/spec/<name>_test.rb`); excluded from the gemspec `spec.files` glob.
- **`e2e/` deps install via `cd e2e && npm ci`** (`e2e/package-lock.json` is tracked —
  consumers need it). The CloudFront-Function specs simulate `Fn::Sub` by substituting
  a synthetic `example.test` apex, so platform specs stay site-agnostic.
- **AST always, never regex, for code-shape lints (Adam's standing rule).** A lint
  that reasons about CODE STRUCTURE — which `test()` blocks exist, whether a
  `guard(SITE_ROOT, …)` sits inside a given test's scope, which collection a
  `page.goto` navigates — MUST parse a real AST, never regex-scan the source.
  Regex on source is brittle: it false-matches tokens in comments/strings,
  mis-reads across line breaks, and is BLIND to interpolation — a regex couldn't
  see `page.goto(\`…#/collections/${CANARY.cmsCollection}\`)` (a *variable*
  collection), which let the jodidaniel host-loop guard gap ship. Parse with
  `e2e/spec-ast.js` (acorn + acorn-walk): `analyzeSpec(src)` returns a fact bag
  (string VALUES with `${…}` placeholders, call names+args, identifiers, requires,
  Program-level `test()` blocks); the detector matches those facts, not raw text.
  This mirrors `e2e/workflow-yaml-utils.js`, which parses workflow YAML with the
  `yaml` parser for the same reason. The guard-registry detector
  (`base-collections-guard-registry.test.js`) + `platformMetaSpecs()` are AST-based;
  any NEW code-shape lint must be too. (Regex stays fine for genuinely lexical
  concerns — a version string, a leaf token's content — never for code structure.)
  Adding the parser deps respected the 7-day dependency cooling-off (above).

## Admin delivery (gem-shipped, v0.1.4+)

`/admin` machinery ships inside the `theme/` gem, not in a site's own repo: a
build-time hook copies it into `_site/admin`, renders `config.yml` from a
site-owned collections seam, and a `base_collections` keep-list can hide the
built-in collections entirely — get any of this wrong and a consumer's
`/admin` silently breaks or shows the wrong collections. → read
`docs/ADMIN-DELIVERY.md` (see also the `admin-config-render` skill) before
touching `theme/admin/`, either render path, or a site's
`collections.site.yml` seam.

### base_collections-aware spec skips for single-page consumers (#33)

A `base_collections: []` single-page consumer (jodidaniel.com's shape) has
none of the generic collections or content most e2e specs assume, so a new
spec that reads a base collection or drives `/admin/index-local.html` must
self-skip precisely or it permanently red-fails that consumer. → read
`docs/CONSUMER-COMPATIBILITY.md` before adding a spec that depends on a base
collection existing.

### Org OAuth App approval — the "can log in but can't save" trap (#26)

On an org-owned consumer, an unapproved OAuth App lets Decap authenticate and
read but silently fails every persist — and there is no reliable API check
for it. → read `docs/CONSUMER-COMPATIBILITY.md` before debugging a "login
works, saving doesn't" report on an org-owned site.

## Skills ship as a marketplace bundle, not a file sync (v0.1.83)

`skills/` is the canonical home of the platform skills and the only place one
is authored — but **nothing copies it into a consumer**. The repo is published
as a federated bundle in the `agentskills` marketplace
(`/plugin install cms-platform@agentskills`, invoked as `/cms-platform:<skill>`);
an ephemeral surface (cloud session, CI runner) gets the same set from that
registry's `skills-bootstrap` SessionStart hook — but only once the **consuming
repo's own** `skills.lock` declares `cms-platform` as a source, pinned to a
commit with per-skill digests. The lock is per-consuming-repo: the registry's
own stays `adam`-only by design and never carries these skills. adamdaniel.ai
declared the source on 2026-08-14 (PR #3109), pinning this repo at `679fb614`
for 14 skills alongside the 9 it takes from `adam`; jodidaniel.com adopted it
on 2026-08-16 (PR #134), taking the same two sources. The `skills-sync.yml`
transport, its `platform-drift-guard.yml` companion, the issue #83
destination-presence gate and the `.repo-local` carve-out were all **deleted**
in v0.1.83 — do not reintroduce a per-consumer mirror, and do not add a
`skills/` copy to a consumer repo. A **consumer adopting v0.1.83 must delete
both thin callers in the same commit as its `platform_ref` bump**, or
workflow-set parity reports MISSING/EXTRA and goes red. → read `docs/SYNC.md`
("Skills — federated, not synced") and `docs/VERSION-HISTORY.md` v0.1.83
before touching skill delivery.

## Single-version pin consistency guard (anti-skew, #29)

A consumer references the platform version in many independent places
(reusable and composite `uses:@ref` pins, `Gemfile`/`Gemfile.lock` tags,
`platform.lock`, and each caller's own `platform_ref:` input) that can drift
out of lockstep piecemeal — a stale `platform_ref` input once silently ran a
14-release-old platform tree. → read `docs/PIN-CONSISTENCY.md` (see also the
`platform-release-and-bump` skill) before changing
`check-platform-pin-consistency.js` or `platform-bump.yml`'s seeding logic.

### A caller naming the version twice must name it the same twice (#283)

Ten repos call a cms-platform reusable; only the two consumers have a
`platform.lock`, a gem and a pin-consistency gate, so every guard on that page
is unreachable from the other eight. Each of their callers names the version
TWICE — `uses: …@vX.Y.Z` and `with: platform_ref: vX.Y.Z` — and Dependabot's
`github-actions` ecosystem moves the first and **structurally cannot** move the
second. The skew is worse than a crash: the NEW reusable runs against the OLD
sparse-checked-out script, an argv-scanning `flag()` ignores flags it does not
know, and the job reports **green** having detected nothing. Measured
2026-08-20: seven of eight a release behind, one of them with fourteen
unreported failing default-branch push runs its own audit could not see.

`scripts/check-pin-agreement.js` asserts the two refs agree, and is deliberately
**identity-free** — no slug, no canonical version, no lockfile; it compares a
file against itself, which is what makes it runnable by a repo with none of the
platform's machinery. It PARSES (`merge: true`), because an aliased or
merge-keyed value is invisible to a line scan. Exit codes are three-valued: `0`
agree, `1` skew, `2` could-not-run — a zero-file scan is `2`, never `0`.

Delivery is `.github/workflows/pin-agreement.yml`, a reusable, because a thin
caller is the only thing these repos can adopt. **Do not add a caller for it to
`examples/site/.github/workflows/`** — that set is the consumer-dictated
workflow set, so a new file there reports MISSING on both consumers until they
adopt it, and the consumers are the two repos this skew cannot reach anyway.
The caller checks ITSELF: it reads the caller's (always current) workflow tree,
so a half-bump is caught even when a stale `platform_ref` supplies the old
script, and a `platform_ref` predating the script fails the step loudly.

→ read `docs/PIN-CONSISTENCY.md` ("Pin AGREEMENT") before changing the checker,
the reusable, or the two options (#283's 2 and 3) deliberately left out of it.

### Dependabot must not bump ANY cms-platform reference (#242, #244)

`platform-bump` owns the platform version atomically — every `uses:@<tag>`
pin, the gem `tag:`, `platform.lock`, every `platform_ref:` input — in ONE
PR, which is what lets `check-platform-pin-consistency.js
--require-canonical` pass on that PR alone. Either Dependabot ecosystem can
only see its own narrow slice, so a Dependabot-authored bump is either
redundant or actively skews the tree (adamdaniel.ai PR #3076 tried to
downgrade the gem `v0.1.80` → `v0.1.75` this way; jodidaniel.com #8–#22
produced fifteen piecemeal `uses:@` bump PRs from one release). Both
consumers and the `examples/site` template now carry an UNSCOPED `ignore`
for `cms-platform-theme` under `bundler` (#242) AND for
`Adam-S-Daniel/cms-platform/*` under `github-actions` (#244) — an
`update-types`/`versions`-scoped ignore would not have stopped either
incident above. Two lints lock both:
`e2e/dependabot-theme-gem-ignored.test.js` (CONSUMER mode) and
`e2e/scaffold-seeds-dependabot-ignore.test.js` (template + scaffolder
output). Do not re-enable either ecosystem for a cms-platform ref. The v0.1.82
release also closed the resulting blind spot — `platform-bump.yml`'s release
lookup no longer folds an auth/API failure into the same green `exit 0` as
"no release published yet"; it now fails loud (`::error::` + `exit 1`) on
anything but a genuine 404. → read `docs/SYNC.md` for the full evidence,
posture-cost, and wildcard-matcher detail.

### A pin carries no version comment - lint-locked (2026-08-20)

The managed half of this file states the rule; these two specs are what stop it
drifting back. Eleven PRs stripped every trailing `# vX.Y.Z (YYYY-MM-DD)` label
fleet-wide and deleted the machinery that regenerated them, but nothing then
ASSERTED the absence - and a convention with no verifier returns the first time
an agent helpfully labels a SHA it just bumped, which is how the labels drifted
out of true to begin with.

- `e2e/action-pin-comment-lint.test.js` - the PLATFORM half: this repo's
  `.github/workflows/`, the `.github/actions/*/action.yml` composites, and the
  `examples/site` thin-caller templates. Registered in `PLATFORM_META_SPECS`.
- `e2e/consumer-action-pin-comment-lint.test.js` - the CONSUMER half: a site's
  own `.github` tree, where most of the fleet's pinned `uses:` lines actually
  live. Deliberately NOT registered (the #244 lesson - registering it would
  testIgnore it on the exact lane it exists for). Do not "tidy" it onto the list.

Both drive one detector, `e2e/pin-comment-rules.js`, so they cannot drift apart.

It PARSES, and that is what makes it correct rather than merely house-style
compliant. YAML comments are outside the data model, so `YAML.parse()` drops
them - but `YAML.parseDocument()` keeps a same-line trailing comment as
`node.comment` (verified against `yaml` 2.9.0 for plain, quoted,
last-line-no-newline, composite-action and flow-mapping shapes), so no lexical
fallback is needed. A line scan would also be WRONG here: two legal shapes carry
a version token in the VALUE - `…/e2e-tests.yml@v0.1.88` and
`docker://alpine:3.20` - and a regex over the line flags both. The detector
reads only the comment, so a tag-pinned own-account ref, a `./local` path and a
`docker://` ref are inherently untouched; there is no carve-out to get wrong.
A trailing comment that is not a version (`# zizmor: ignore[...]`) stays legal.

## Consumer-context spec rule (v0.1.5)

A spec that runs in CONSUMER mode (`SITE_ROOT` set) must never read admin
from the platform source tree (`theme/admin`) or the platform's own workflow
definitions — consumers don't have them, and an unregistered
platform-internal spec ships green here and red-fails on the next consumer.
→ read `docs/CONSUMER-COMPATIBILITY.md` before writing a new e2e spec or
touching `PLATFORM_META_SPECS`.

### A consumer's nudge `required_contexts` is bound to its OWN ruleset (#284)

`required_contexts` is the auto-merge nudge's entire notion of "green" — the
reusable builds `REQUIRED` from it and gates `pulls.merge()` on every member
being green. A list SHORTER than the repo's real required set therefore asks
for a merge it has not established. jodidaniel.com passed ONE of six for months
(jodidaniel.com#156); it was safe only because `pulls.merge()` answered 405 on
its behalf, i.e. safe by accident.

`e2e/consumer-automerge-nudge-contexts.test.js` closes it where it has to hold —
on the site whose branch protection is doing the waiting. It reads the manifest
the consumer's own lane checked out (`<SITE_ROOT>/.cms-platform/repo-settings.yml`
— every lane that runs this harness against a site checks the WHOLE platform out,
no `sparse-checkout:`), looks the site up by `CMS_REPO`, and asserts its
`required_contexts` equals that repo's `rulesets.main` → `ruleset_library[…]`
→ `required_status_checks` set, is non-empty, and is ` / `-shaped throughout.

Three things about it that are decisions, not accidents:

- **It is deliberately NOT in `PLATFORM_META_SPECS`** — registering it would
  testIgnore it on the CONSUMER lane it exists for (the #244 lesson that also
  keeps `consumer-required-check-mirrors.test.js` unregistered). It requires the
  `yaml` library DIRECTLY rather than through `workflow-yaml-utils.js`, because
  the registry's `workflows-def` detector treats that require as an
  unconditional platform signal; its one `.github`/`workflows` path join is
  SITE_ROOT-rooted for the same reason.
- **The oracle is PINNED, not live** — it is the manifest at the site's own
  `platform_ref`, so it lags in the false-GREEN direction. Accepted knowingly:
  reading the live ruleset is a network call this suite forbids, the window is
  one release wide (a bump moves `platform_ref` and every `uses:@` together),
  and a pinned check would still have caught #156 by months.
- **A site absent from `repos:` FAILS, it does not skip.** The objection that
  killed earlier attempts — "a scaffolded site isn't in the manifest, so it
  needs a skip" — is the argument for failing: rulesets change only via a
  `repo-settings.yml` PR, so absence means no MANAGED ruleset at all and a nudge
  anchored to nothing. A soft path there would land on exactly the sites with
  the least review behind them.

The platform-side half stays `e2e/cms-automerge-nudge.test.js` (the TEMPLATE's
list vs `ruleset_library.consumer-main`). Neither covers the other's surface.

## Editorial-workflow label audit (v0.1.6; self-heal + label-at-creation v0.1.48)

Decap re-runs its editorial-workflow label migration on **every** `/admin` load
(the persistent "Decap CMS is adding labels to N of your Editorial Workflow
entries" dialog) when an open editorial PR (a `cms/*` branch) is **missing** its
`decap-cms/<draft|pending_review|pending_publish>` label — repo-wide, so it
shows on prod AND every preview deploy. Guards:

- `e2e/cms-editorial-label-migration.spec.js` — drives the in-browser test-repo
  backend; asserts the dialog is ABSENT, or gone after dismiss + 30s + reload
  (never survives that cycle).
- `scripts/audit-editorial-labels.js` — flags open `cms/*` PRs missing a
  `decap-cms/<status>` label; exits non-zero with `::error::` annotations.
  With `--fix` (the reusable's default since v0.1.48) it SELF-HEALS instead:
  applies `decap-cms/pending_publish` when the PR carries `cms/ready` (it is
  literally queued to publish), else `decap-cms/draft`, and only exits
  non-zero when a fix didn't stick — a red audit now means "needs a human".
  Motivation: the flag-only audit went red daily for a week (PR #2387,
  2026-07) while the "adding labels…" dialog sat on prod — scheduled-run
  failures are invisible, so detect-only was the wrong contract.
- `.github/workflows/editorial-label-audit.yml` — reusable; consumers wire a
  daily-cron caller (sparse-checks out just the audit script from the platform). It
  MUST pass `--repo ${{ github.repository }}` (v0.1.16): the sparse checkout
  leaves no git repo in `github.workspace`, so a bare `gh pr list` fails
  `not a git repository`. Self-heal needs `pull-requests: write` from the
  CALLER (reusable permissions are capped by the caller's grant); with only
  `read` the fix 403s and falls back to failing loud. Lint-locked by
  `e2e/editorial-label-audit-repo.test.js`.
- **Label at creation (v0.1.48):** every non-Decap writer that opens a `cms/*`
  PR applies `decap-cms/pending_publish` alongside `cms/ready` so the
  migration never has a target in the first place — the publish-via-auto-merge
  shim's delete-recovery PRs, `cms-fixture-pr.js` seed/remove fixture PRs, and
  `sweep-stale-cms-prs.yml`'s two cleanup PRs. (Decap-created editorial PRs
  label themselves.) The pre-v0.1.48 "`cms/e2e-fixture/remove-*` PRs
  transiently red the audit — expected churn" caveat is obsolete: those PRs
  are labelled at creation now, and the audit heals any stragglers.

## Dependabot batch-strand re-arm sweep (#118-122 postmortem)

A batch of Dependabot PRs opened together can strand indefinitely — GitHub
auto-disables auto-merge once the first PR in the batch merges, and every
later merge also leaves the rest genuinely behind `main`, which re-arming
alone can't fix. → read `docs/CI-INVARIANTS.md` before touching
`dependabot-rearm-sweep.yml` or its merge/re-arm logic.

## Scheduled-run health audit (silent-failure alerting, v0.1.57)

Scheduled workflows fail silently — no PR goes red and nothing notifies
anyone — so a broken daily audit or sweep can run red for weeks unnoticed. →
read `docs/CI-INVARIANTS.md` before changing `scheduled-run-health.yml` or
`audit-scheduled-runs.js`, including the runner-starvation false-alert
carve-out.

## E2E parallelism — one CI job per Playwright project (v0.1.68-v0.1.70)

`e2e-tests.yml` runs one CI job per Playwright project rather than the whole
suite in one job — a design backed by specific, sometimes counter-intuitive
worker-count and browser-install measurements that are easy to accidentally
undo. → read `docs/E2E-PARALLELISM.md` before re-tuning workers, sharding,
or the browser-install step.

## E2E local webServer: decap readiness + :4000 crash resilience

The local e2e lane's two webServers have non-obvious readiness/crash
requirements — decap-server must be probed by open TCP port, not a `url:`
HTTP check, and the `:4000` static server must not be bare `serve` (a racy
ENOENT there once cascaded into an 85-test failure). → read
`docs/CI-INVARIANTS.md` (see also the `browser-testing` skill) before
touching `e2e/playwright.config.js`'s local `webServer` config.

## A cancelled required check blocks the merge (#1815, #285, #289)

A required-check job that can fire more than once on the same head sha
(label or multi-event triggers) will eventually leave a cancelled run
shadowing a success — and no merge mechanism can override a cancelled
required check, so the PR blocks non-deterministically.

**The invariant is the OUTCOME, not one key: NO REQUIRED CONTEXT MAY END
`cancelled`.** Naming it after `concurrency` is what let a second cause ship
underneath the first. #285 removed every group from every required-context
publisher; four days later `parity / parity` and
`preview-media / preview-media` still concluded `cancelled` on adamdaniel.ai
#3202/#3217 — on a `timeout-minutes` wall, because **GitHub reports a job it
killed at its wall as `cancelled`, not `timed_out`**. The wall now lives on a
work job whose conclusion no ruleset names, with the required context published
by a `needs:` + `if: always()` gate that translates — the shape `e2e-tests.yml`
already used for `e2e / e2e`. → read `docs/CI-INVARIANTS.md` before adding a
`concurrency` block **or a `timeout-minutes`** to any job that produces a
required status context; the guards are
`e2e/required-context-cancellable.test.js` (renamed from
`…-concurrency.test.js` at #289) and its CONSUMER-mode sibling.

## Admin-bundle parity is bump-aware (#14)

The admin-bundle parity check has to tell a legitimate gem-bump lag (prod
still serving the old bundle) apart from real prod drift, and the
`window.CMS_*` identity injection has to be normalized out of the byte
compare or every admin PR false-fails. → read
`docs/CONSUMER-COMPATIBILITY.md` (see also the `admin-config-render` skill)
before changing `e2e/admin-bundle-parity.js` or the render hook's inject
globs.

## Self-CI lanes

`.github/workflows/self-ci.yml` is the machinery repo's own merge gate (every
other workflow here is an `on: workflow_call` reusable; `self-ci.yml` plus its
sibling `self-secrets-scan.yml` — which dogfoods the `secrets-scan.yml`
reusable on this repo's own history — are the only two that run directly on a
plain PR). It runs five FAST lanes on `pull_request` + `push` to `main`:

1. **actionlint** over `.github/workflows/*.yml` (downloads the pinned binary; hard-fail).
2. **ruby-theme-specs** — `theme/spec/*_test.rb` (hard-fail).
3. **node-unit-lints** — the pure-fs `e2e/*.test.js` lints, selected by an
   exclusion DENY list (build-/repo-dependent specs are denied; a new pure-fs
   lint is picked up automatically). Run with `TARGET=prod` +
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so no Jekyll/browser bring-up (hard-fail).
4. **plugin-validate** — `claude plugin validate .` over this repo's own plugin
   root (hard-fail), NON-STRICT deliberately: the repo-root `CLAUDE.md` emits a
   permanent "not loaded as project context" warning that `--strict` would turn
   into a failure, and `CLAUDE.md` is managed by the `_agent-guidance` sync and
   is not ours to delete — so `--strict`'s only green path is removing a file we
   must keep.
5. **cfn-lint** over the CloudFormation templates (advisory, `continue-on-error`).

`self-secrets-scan.yml` (#126) runs alongside it as its own workflow,
gitleaks-scanning the platform repo's diff on `pull_request`, incrementally on
`push` to `main`, and full-history weekly — the same posture the consumer
caller gets from `secrets-scan.yml`, applied to the machinery repo itself.

The heavy browser matrix + `@admin-write` write-path specs run in **CONSUMER**
e2e (dogfood / consuming-site CI), NOT in platform self-CI.

## Adding / porting a workflow

Make it `on: workflow_call` with site identity as `inputs`/`secrets`; keep
`github.repository`/`context.repo` (already portable). The site's `on:` trigger
+ `paths-ignore` + `run-name` live in a **thin caller** under
`examples/site/.github/workflows/`. If the workflow needs platform-owned scripts,
check the platform out into `.cms-platform/` (a dot-dir Jekyll ignores) at
`inputs.platform_ref` and run them from there (see `deploy-preview.yml`).

## Verify

```bash
ruby scripts/render-decap-config.rb <site> <site>/_site   # Decap render
node scaffold/create-site.js /tmp/x --yes --domain d --repo d --owner o   # scaffolder
# workflows: python3 -c 'import yaml,...' parse + bash -n the run: blocks
```

## Definition of done (non-trivial changes)

A merged PR with green unit-lints is **NOT** "done" for any non-trivial change
to this platform or a consumer. Green unit lints routinely ship a LIVE
regression (Decap UI drift, deploy-chain, dialog handling — e.g. the
double-`dialog.accept()` crash on loop run 27013147945 that NO unit lint or
adversarial code-review lens caught). "Done" additionally requires:

1. **Drive the prod-mutate validation loop to GREEN.** Dispatch
   `cms-publish-loop-prod.yml` (and `cms-media-roundtrip.yml` where the change
   can affect it) on the affected site and ITERATE until a run actually
   succeeds end-to-end (create → reflect → delete → 404) — not "the fix looks
   right" or "the dispatch-proof passed." The live loop is the real acceptance
   test for these CMS repos.
2. **Survey + drive every workflow green, in ALL THREE repos.** A platform
   change cascades, so the audit spans `cms-platform` AND **both** consumers
   (`adamdaniel.ai`, `jodidaniel.com`) — not just "the repo you edited". For
   EVERY workflow: it must have a run AFTER the last non-CI-generated push, and
   its most-recent run must SUCCEED. Iterate — re-dispatch stale / scheduled /
   manual ones — until that holds. ("CI-generated / non-real" = loop-canary
   churn + cleanup/auto-merge bot PRs + the automated `platform-bump` PR +
   auto-docs regen; those don't reset the bar — the reference point is the last
   *substantive* (human / code / content) change.)

   Survey method + nuances (2026-06-05 — `gh api repos/<r>/actions/workflows`
   → per-workflow latest run on `main`; compare its `head_sha`/`created_at` to
   HEAD / the last non-bot commit):
   - **In `cms-platform` itself, most workflows are `workflow_call`-only
     reusables** — they CANNOT run standalone (they show "no main run"); they're
     exercised when a consumer's thin caller invokes them, plus the harness
     lints run in **Self CI**. So the platform's own bar = **Self CI green on
     HEAD** (+ Cut release / Dependabot). Don't chase "no main run" on a reusable.
   - **A bump-skip-SKIPPED loop run is GREEN but is NOT a real validation.** The
     `recursion-gate` skips the prod loops on a bump-only push, so their
     post-bump run "succeeds" by skipping — that satisfies #2's "latest run
     succeeded" but NOT #1. Drive a REAL prod-mutate cycle by `workflow_dispatch`
     (it bypasses the bump-skip), confirming the heavy job actually ran.
   - **PR-triggered workflows** (`parity`, `preview-media`, `e2e`,
     `visual-regression`, the preview-env loops) last ran on the PR head, not
     `main` — a green run on the last real PR satisfies the bar; their
     "no main run" / stale-main-sha is expected.
   - **`startup_failure` or an old failed manual dispatch still counts as a RED
     latest run** — re-dispatch on current HEAD (the preview-env loops need a
     live `preview-pr<N>` target) until the latest run is green.
3. **No OPTIONAL / non-required check may fail either.** Drive `UNSTABLE` →
   clean, not just `BLOCKED` → mergeable. A merged PR with a red non-required
   check is not done — chase it to green, OR, if it is genuinely a
   user-credential / go-live blocker (jodidaniel `CMS_E2E_PAT`, the excluded
   jodidaniel #26), surface it explicitly rather than leaving it silently red.

This gate is part of the `platform-release-and-bump` flow — apply it after the
consumer bump, not before.

### Delegated mechanical work is done when a VERIFIER exits 0

From the v0.1.76 consumer bump, which was delegated to two small-model subagents
with an exact spec that ENDED in "run the authoritative gate":

- **Done means an exit code, not prose.** Name the exact verifier command in the
  spec as the definition of done and require its exit code in the report. Neither
  agent ran it, and its exit code was the one thing that would have caught the
  incomplete work unambiguously.
- **A subagent that cannot run the verifier must report BLOCKED.** Partial
  completion described as progress is the failure mode: one agent stopped after 3
  of 5 edit categories having INVENTED a constraint it was never given, left 58
  stale `v0.1.75` refs and no `app_private_key`, and its report read as near-done.
- **A count that disagrees with the spec's stated expectation is a
  STOP-AND-REPORT condition**, never "minor variance from counting methodology".
  Today's 35-vs-34 was benign (a prose `vX.Y.Z` mention in a comment), but nothing
  in the process established that — the orchestrator had to.
- **Prefer a verifier that CANNOT silently degrade.** `check-platform-pin-consistency.js`
  used to drop from 96 checks to 61 with no canonical set and still print "Pins are
  consistent", so even an agent that DID run it could be falsely reassured. Hence
  `--require-canonical` (which the `platform-pin-consistency` reusable now passes).

For a consumer pin bump that verifier is **`scripts/verify-consumer-pins.sh`**
(run from the consumer root; `--platform-dir <path>` when the platform tree is
elsewhere) — a green run of it, not a diff review, is what makes the bump done.

## E2E workflow matrix (ported)

The real-prod loops (`cms-publish-loop-prod`/`-host`, `cms-media-roundtrip`)
share a hard-mutual-exclusion concurrency lane, a recursion gate that must
tolerate a bump-only push, and a deploy-lane diagnostic that must ask
whether the PR actually merged before blaming the deploy chain. → read
`docs/CI-INVARIANTS.md` (see also the `ci-watcher-loops` and
`cms-stuck-pr-triage` skills) before touching any of the three real-prod loop
workflows or their shared composites.

## Remaining work

Two items remain genuinely open (verified against the full change history in
`docs/VERSION-HISTORY.md`); everything else this section used to track — the
reusable-workflow port, the e2e meta-lints, the PR #1 completeness pass, the
`e2e-required-stub.yml` port, pixel-regression baseline retirement — shipped:

- **Deliberate skips — permanently NOT ported** (site-specific, not reusable
  machinery): `code-quality` stays platform-internal and is never shipped to
  consumers; `ci-runner-image` (the adamdaniel-only GHCR prebaked image) was
  already dropped from the e2e port in favor of inline dependency installs.
- **`playwright-image-drift`'s "real repo is drift-free" subtest can't
  self-check against this repo** — cms-platform ships no root
  `package-lock.json` or `.github/ci-runner/Dockerfile` for it to read, so
  that subtest exercises fully only against the synthetic `scaffold()`
  fixtures; it runs green for real only in a consuming site that has both
  files.

## Version history

Every release from `v0.1.0` to the current one, with the incident/root-cause
writeup behind each fix — the single largest chunk of this file, and the
place most "see version history" pointers elsewhere resolve to. → read
`docs/VERSION-HISTORY.md` before assuming something hasn't been fixed yet, or
when you need the full story behind a fact stated tersely above.

## Consumers

- **adamdaniel.ai** — consumer #1, user-owned, the dogfood. Migrated to
  gem-delivered admin (PR #1883); live prod `/admin` verified. Daily
  editorial-label-audit adopted. (A loop co-arrival fix #1892 narrowed the host
  publish-loop's push trigger to its own canary surfaces so it stops evicting
  prod-mutate in the shared `prod-mutating-loop` concurrency lane — see
  `docs/CI-INVARIANTS.md`'s "E2E workflow matrix (ported)" section.)
- **jodidaniel.com** — consumer #2, org-owned, a SINGLE-PAGE bio. `/admin`
  restructured into 9 per-section collections (5 folder collections ordered by a
  numeric `weight`, declared `output:false`; 4 file collections reading
  `_data/*.yml`). `cms.base_collections: []` hides the generic collections. A
  live-gate in `_data/settings.yml` `site_live` (default `false`) keeps prod
  coming-soon with zero bio leak. Go-live is tracked in jodidaniel issue #26. Its
  token-driven CMS automation (cms-automerge-nudge, auto-resolve-newline-conflict,
  sweep-stale-cms-prs) runs on a provisioned **`CMS_E2E_PAT` repo secret**; the
  scheduled-workflow failures observed through mid-2026-07 were actually the
  sweep/reaper bugs fixed in v0.1.49-v0.1.51 (missing-directory-listing crash
  #127, `gh api` error-stdout capture #130), not a missing secret.

## Roadmap / open issues

All four items this section used to track are DONE — issue #5 GOAL 1 (v0.1.4,
admin consolidation), issue #5 GOAL 2 (the v0.1.9–v0.1.12 sweep,
`field_library` + `$ref`), issue #21 (v0.1.13, CloudFront `ErrorCachingMinTTL`),
and issue #22 (ephemeral canary-branch cleanup). See `docs/VERSION-HISTORY.md`
for the release that shipped each. No open items remain in this list.

## Environment gotchas (this machine / web)

- **The local checkout can be STALE/detached** — before any analysis or work,
  `git fetch && git checkout main` (or compare against `origin/main`), then branch
  off `origin/main`. An old checkout may not reflect landed migrations (e.g. the
  `admin/` → `theme/admin` move, the gem-delivered admin model) and you'll reason
  about machinery that no longer exists. Verify HEAD == `origin/main` first.
- The **web** GitHub MCP connector can't create repos (403); `/teleport` to local
  and use `gh` (authed as Adam-S-Daniel, scopes incl. `repo`,`workflow`).
- Background sessions: editing a non-cwd repo checkout trips a worktree-isolation
  prompt on the Edit/Write tools — write via Bash (`cat >`, a Python pass) which
  isn't tool-guarded. Writing `.claude/settings.json` is blocked as self-mod.

### A live repo-settings check may be IMPOSSIBLE from the session (v0.1.76)

The egress proxy in a sandboxed authoring session returns **403 for
`/actions/variables` and `/actions/secrets`** on all three repos, so whether a
credential is actually provisioned cannot be verified from there — during
v0.1.76, `CMS_AUTOMATION_APP_ID` / `CMS_AUTOMATION_APP_PRIVATE_KEY` could not be
confirmed. **State the limitation honestly rather than asserting either way**, and
design credential-dependent features to **fail SOFT**: absent credentials must
produce a clear notice that names the EXACT knobs, never a crash and never a
silent no-op. The pattern was set by `dependabot-comment-sync.yml` (deleted
2026-08-20 with the pin-comment convention): no App credential simply meant it
skipped with a notice naming all three knobs (`CMS_PLATFORM_PAT` /
`vars.CMS_AUTOMATION_APP_ID` / `CMS_AUTOMATION_APP_PRIVATE_KEY`), which is what
keeps "never onboarded" distinguishable from "misconfigured". `repo-settings-apply.yml`
carries the same shape today. Note `CMS_AUTOMATION_APP_ID` /
`CMS_AUTOMATION_APP_PRIVATE_KEY` now have NO consumer — the passthrough in
`scripts/set-repo-variables.sh` is kept for the next workflows-scoped job, not
because something reads it.

## Approving `regression-review` on a render-neutral PR

`visual-regression` screenshots the PR against **production**, and prod lags
`main` — so a version-bump or delete-only PR that changes nothing a visitor sees
routinely reports pre-existing drift as its own diff and parks on the manual
`regression-review` gate.

- Do NOT re-run hoping it flips green, and do NOT widen the salience detector
  (`e2e/detect-changed-pages.js`) or the thin caller's `paths:` content-skip list
  to dodge it — both are lint-locked
  (`e2e/visual-regression-content-skip.test.js`, `-skip-review.test.js`) and
  widening either blinds the gate for every future PR.
- Read the shape first: `Visually different ≥ 1` with `Text changed: 0` is the
  false-positive signature (see `docs/VERSION-HISTORY.md`, v0.1.73).
- Prove the PR is render-neutral BEFORE approving. Both must hold:
  `git diff --stat <old-tag> <new-tag> -- theme/` is EMPTY (the gem's render is
  unchanged), and every deleted asset is unreferenced across `_layouts/`,
  `_includes/`, the index page and `_config.yml`.
- Only then approve the environment gate:
  `gh api repos/<owner>/<repo>/actions/runs/<run-id>/pending_deployments` to read
  the environment id and `current_user_can_approve`, then
  `gh api -X POST .../pending_deployments -f state=approved -F "environment_ids[]=<id>"`.
  The approver must be a configured reviewer of the `regression-review`
  environment (see the `consumer-repo-provisioning` skill).
- If either check fails, the gate is doing its job — review the pixels, don't
  approve.

## A validation dispatch tests the code that is REACHABLE, not the code you merged

A host-loop iteration costs over an hour (`cms-publish-loop-host.yml` runs four
`@admin-write` specs at `--workers=1`, `timeout-minutes: 150`), so a dispatch
that exercises the wrong bytes burns a whole cycle. Two ways that happens, both
observed:

- **The CDN is still serving the old admin.** `deploy-production` concluding
  `success` is NOT proof prod `/admin` changed: the admin assets sit behind
  CloudFront and the deploy fires `create-invalidation` WITHOUT waiting for it to
  complete, so the edge can keep serving the previous asset for minutes. A
  re-dispatch once raced it, fetched the old `publish-via-auto-merge.js`, and
  spent a full run failing on a defect that was already fixed and merged.
  **Curl the served asset and grep for the new symbol before dispatching:**
  `curl -s https://<apex>/admin/<file>.js | grep <new-symbol>`.
- **`gh workflow run` against a stale branch.** Dispatching on a dead feature
  branch runs THAT branch's code and resurrects failures the fix already removed.
  Dispatch on current HEAD, and delete feature branches once merged.

So for any change to a gem-shipped `/admin` asset: land the consumer bump, let
its `deploy-production` finish, verify the SERVED asset, then dispatch.

## Diagnose a failed loop run from its ARTIFACTS, not from the logs

`gh run download <run-id>`, then read `test-failed-1.png` and `error-context.md`
BEFORE theorising. A host-loop iteration is over an hour of real prod mutation
(`cms-publish-loop-host.yml` runs four `@admin-write` specs at `--workers=1`,
`timeout-minutes: 150`), so a wrong guess costs a full cycle — and what these
specs catch are Decap UI-state bugs (a Save button gone `disabled`, a confirming
toast that already faded) that a log physically cannot show. The v0.1.36 layer in
`docs/VERSION-HISTORY.md` was cracked by the screenshot alone, after log-reading
had already produced two wrong root causes.

## Pre-run the required lint lane locally

`node-unit-lints` is a REQUIRED check and the cheapest one to reproduce. Mirror
it from `e2e/`:

```bash
TARGET=prod PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npx playwright test --project=chromium-light --reporter=line ./*.test.js
```

Run the WHOLE `*.test.js` set, not just the files you touched — these lints
cross-reference each other, so an edit in one file routinely reds a lint in
another.

Two classes of local red are EXPECTED, not regressions: the build-dependent
specs on `self-ci.yml`'s DENY list, and anything needing a Jekyll toolchain on a
box that has none. Check a red against that list before chasing it.

## Install the e2e fixture's gems into the fixture, not the system gem path

With `GEM_HOME` unset, bundler defaults to an unwritable `/var/lib/gems` and the
`e2e/fixture-site` gem install fails outright — which blocks every lint that
needs the fixture's `bundle exec` (e.g. `e2e/base-collections-skip-meta.test.js`,
which requires the fixture to have resolved gems). Scope the fix to the fixture
rather than fixing it globally:

```bash
cd e2e/fixture-site && bundle config set --local path vendor/bundle && bundle install
```

`vendor/` and `.bundle/` are already gitignored there — and `.bundle/` is
precisely what does NOT travel with a clone, so this is a one-time step on every
fresh checkout, not a fix someone forgot to commit.

## Before deleting anything from a consumer, grep the PLATFORM too

A file with no references anywhere inside a consumer repo can still be
load-bearing: the platform's own e2e specs reach into a consumer's tree by
HARDCODED path, and a consumer-only grep is blind to that.

A thin-ification audit that checked page and site references only listed
`assets/images/uploads/e2e-preview-media-probe.png` as a stray upload safe to
delete. It is the sentinel `e2e/preview-media-resolves.spec.js` fetches to prove
the flat `media_folder` resolves on the preview surface — deleting it 404s the
probe and reds the REQUIRED `preview-media` check.

So: grep **all three repos**, `cms-platform/e2e` and `cms-platform/scripts`
included, before removing a consumer file. "No in-repo references" is a necessary
condition, never a sufficient one. (That specific sentinel is now lint-locked by
`checkMediaProbeSentinel()` in `scripts/check-platform-pin-consistency.js` and by
`e2e/scaffold-seeds-media-probe.test.js` — the class of miss is not.)
