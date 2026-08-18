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

## Pinning GitHub Actions

**Every `uses:` is pinned to a full 40-character commit SHA** — in workflows,
composite actions, and reusable-workflow references alike. Never a tag, never a
branch, never an abbreviated SHA. A tag is a movable pointer: pinning to one
gives whoever can retag the upstream repo a shell on the runner, holding that
job's token.

```yaml
uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1 (2023-10-17)
```

- **The trailing `# vX.Y.Z (YYYY-MM-DD)` comment is part of the pin.** Forty hex
  characters say nothing on their own; the version says what it is and the date
  says how stale it is. Dependabot rewrites the SHA and the version but not the
  date, so dates drift — cosmetic, a chore, never an incident.
- **Wait 7 days after a release before adopting it** — the cooling-off above,
  applied by hand. If the newest release is younger than that, pin the previous
  one.
- **Dereference annotated tags.** `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`
  returning `.object.type == "tag"` gives you the tag object's SHA, not the
  commit's, and pinning that fails at runtime. Follow it with
  `git/tags/<that-sha>`, or ask git directly:
  `git ls-remote <url> 'refs/tags/<tag>^{}'`.
- `./local/path` and `docker://` refs have nothing to pin. Leave them.

This is enforced, not merely expected: `sha_pinning_required: true` is set on
every repo — by `repo-settings`' `fleet.yml` for the fleet, and by
`cms-platform`'s `repo-settings.yml` for the three sites it manages.

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
- **That adoption is opt-in and per-repo; most repos have not adopted.**
  Delivery is allowlisted in `_agent-guidance`'s `repos.yml` *and* requires the
  repo to have committed a `skills.lock` of its own first — the fleet sync
  never writes one, because the lock is each repo's own declaration of which
  bundles it installs (some federate several registries). So in an unfamiliar
  repo, look for `skills.lock` rather than assuming either way. Bundles cost
  always-on context in every session that carries them, which is why this is a
  deliberate per-repo decision and not a fleet default.
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

**Current release: `v0.1.85`** — `v0.1.0`–`v0.1.85` are all tagged GitHub
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
- **SHA-pin every workflow `uses:`** with a `# vX.Y.Z (date)` comment; 7-day
  cooling-off before bumping (mirrors adamdaniel.ai policy).
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
(`uses:@ref` pins, composite SHA comments, `Gemfile`/`Gemfile.lock` tags,
`platform.lock`, and each caller's own `platform_ref:` input) that can drift
out of lockstep piecemeal — a stale `platform_ref` input once silently ran a
14-release-old platform tree. → read `docs/PIN-CONSISTENCY.md` (see also the
`platform-release-and-bump` skill) before changing
`check-platform-pin-consistency.js` or `platform-bump.yml`'s seeding logic.

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

## Consumer-context spec rule (v0.1.5)

A spec that runs in CONSUMER mode (`SITE_ROOT` set) must never read admin
from the platform source tree (`theme/admin`) or the platform's own workflow
definitions — consumers don't have them, and an unregistered
platform-internal spec ships green here and red-fails on the next consumer.
→ read `docs/CONSUMER-COMPATIBILITY.md` before writing a new e2e spec or
touching `PLATFORM_META_SPECS`.

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

## A cancelled required check blocks the merge (#1815)

A required-check job that can fire more than once on the same head sha
(label or multi-event triggers) will eventually leave a cancelled run
shadowing a success — and no merge mechanism can override a cancelled
required check, so the PR blocks non-deterministically. → read
`docs/CI-INVARIANTS.md` before adding a `concurrency` block to any job that
produces a required status context.

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
  prod-mutate in the shared `prod-mutating-loop` concurrency lane — see agent
  memory `cms-prod-loops-no-concurrent-runs`.)
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
silent no-op. `dependabot-comment-sync.yml` is the pattern — no App credential
simply means it skips with a notice naming all three knobs
(`CMS_PLATFORM_PAT` / `vars.CMS_AUTOMATION_APP_ID` /
`CMS_AUTOMATION_APP_PRIVATE_KEY`), which is what keeps "never onboarded"
distinguishable from "misconfigured".
