<!-- BEGIN MANAGED SECTION — DO NOT EDIT ABOVE "## Repo-specific additions" -->
<!-- Source: _agent-guidance -->
<!-- Sections: none -->
<!-- Mode: stub -->

# AGENTS.md

> **Managed by [`_agent-guidance`].**
> Edit only below the `## Repo-specific additions` header.
> Everything above it will be overwritten on the next sync.

## Fleet guidance is delivered once per session — not by this file

The account's full guidance — incidents, fleet policy, machine layout, the
traps that cost real outages — is installed into **user memory**
(`~/.claude/CLAUDE.md`) by the `fleet-memory` SessionStart hook, so it is
loaded **once per session** no matter how many repos are attached. It used to
be inlined here in every repo, which meant a session with 19 repos open
carried 19 identical copies: 332.3k tokens of a 1M window, measured
2026-08-29.

**Check the session-start verdict before you rely on it.** The hook prints one
line:

- `fleet-guidance: installed (v<id>, <n> bytes)` or `fleet-guidance: current` —
  the full guidance is in context. Use it.
- `fleet-guidance: DEGRADED — <reason>` — it is **not** in context. You have
  only what is below. Read `agents-md/base.md` in the `_agent-guidance`
  checkout (or on GitHub) before non-trivial work, and say in your reply that
  you were running degraded.
- `fleet-guidance: skipped (FLEET_GUIDANCE_SKIP set)` — also not in context,
  but by the machine owner's deliberate choice, not a fault. User memory is
  GLOBAL on a durable machine, so the guidance would otherwise load in every
  unrelated project on that box; `FLEET_GUIDANCE_SKIP` opts out and removes any
  block an earlier session installed. Read `agents-md/base.md` the same way you
  would when degraded — just don't report it as a problem or try to "fix" it.

No verdict at all means the hook never ran — treat that as DEGRADED.

## The floor: rules that hold even when the guidance did not load

These are the ones with teeth. They are restated here, deliberately, because a
session that lost the guidance must not also lose these.

- **Branch protection is real.** Fleet repos are PR-only on their default
  branch; a direct push is rejected (GH013), even from the repo's own
  workflows. Never design a bot that pushes to a protected default branch.
- **Every `uses:` is pinned to a full 40-character commit SHA, with no
  trailing version comment.** The one carve-out is a ref into this account's
  own `cms-platform`, which stays on its release tag.
- **Never commit secrets or `.env` files, and never print personal data to a
  CI log** — logs, artifacts and git history on a public repo are public.
- **A successful `git push` does not mean your commit exists.** A refused
  pre-commit hook still lets the push report success. Verify with
  `git merge-base --is-ancestor <sha> origin/<branch>` — it is the only check
  that names both the commit and the ref.
- **"The watch finished" is not "CI passed."** Read the parsed conclusions;
  never infer pass/fail from a watch command's exit code.
- **A GitHub 404 means "not authorized", not "not there."** Never report a
  repo, PR or branch as gone on a 404 alone.
- **The fleet spans TWO owners** — `Adam-S-Daniel` and `jodidaniel`. A query
  scoped to one returns a plausible, complete-shaped, wrong answer.
- **Anything you name gets its link** — what you hand over, what you are
  waiting on, and what you cite as already done.
- **Merge with a merge commit** (`gh pr merge --merge`); do not amend
  published commits or force-push shared branches.

<!-- END MANAGED SECTION -->
## Repo-specific additions

# AGENTS.md — working in cms-platform

Reusable CMS machinery extracted from **adamdaniel.ai**, so new sites get the
same Jekyll + Decap + AWS stack and platform improvements sync **both ways**.
Read this before changing anything here. Design: `docs/ARCHITECTURE.md`. Sync
model: `docs/SYNC.md`.

**Current release: `v0.1.100`** — `v0.1.0`–`v0.1.100` are all tagged GitHub
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
| `docs/PUBLISHING-UX.md` | you're touching how publish/status is PRESENTED to an editor — the toolbar shims, the status model, the deploy-status surfaces, or any copy an editor reads. |
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

## Publishing is presented as nine overlapping statuses (#329 follow-on)

An editor on these sites meets nine different notions of "published" across
four systems, and the two most consequential are invisible to them: six
required checks, and a MANUAL `regression-review` environment gate that can
park a publish indefinitely with no error anywhere in `/admin`. Two of the
nine contradict each other outright — Decap's **workflow board** hard-gates
publishing on `Ready` (`WorkflowList.requestPublish` alerts and returns
otherwise) while the **entry editor's** Publish dropdown has no status gate
at all, and on this platform setting `Status: Ready` publishes on its own,
because `auto-merge-when-ready` fires on the `decap-cms/pending_publish`
label Decap writes.

Two rules that came out of the fix and generalise past it:

- **No admin shim may paint a `position: fixed` overlay over the editor
  toolbar.** `publish-step-hint.js` did, and covered 68% of the Publish
  button its own text was pointing at. It shipped because `pointer-events:
  none` makes an overlay invisible to a HIT-test occlusion guard
  (`elementFromPoint`), and because the `@admin-read` viewport matrix
  (3000x1500 and 393x852) brackets the band where a centred overlay actually
  lands — the damage is zero at both matrix points and 68% at 1280x800.
  `expectNoInjectedOverlap` in `e2e/ui-visibility.js` asks the geometric
  question at pinned widths; `e2e/admin-329-shims.test.js` carries the
  pure-fs half for both shims.
- **A lint that forbids a token must not read comments.** The first draft of
  that lint was `/position\s*:\s*fixed/` over the source and it red-failed
  the fixed file, whose header comment explains the defect. It parses now
  (acorn, string literals + style writes only) — the house AST rule, in its
  cheapest possible form.

**All five staged phases shipped in v0.1.96.** Both doors are now one:
`one-door-publish.js` hides the Status dropdown, the Workflow nav link and
the `#/workflow` route on the PRODUCTION shell (only — `index-test.html`
must keep exercising Decap's real controls, and `index-local.html` has no
editorial workflow to hide). `publish-button.js` replaces the split button,
`publish-progress.js` polls the entry's own PR so the 5-15 invisible minutes
report, and `entry-status-model.js` is the ONE derivation both the editor bar
and the collection list render.

Three things from that work worth knowing before you touch any of it:

- **An `auto-merge-when-ready` re-arm needs the label REMOVED first.** The job
  fires on the `labeled` event and GitHub emits none for a label already
  present — so the second Publish press, the one that follows a "Needs
  attention", would 200 and do nothing.
- **A shim that hides a Decap control must not hide it before its replacement
  is on screen**, and must not write the hiding styles on the steady state:
  an unconditional style write fires an `attributes` mutation inside the
  subtree `publish-step-hint.js`'s own observer watches, twice a second.
- **`mergeable` is absent from the `/pulls` LIST response** — only the
  single-PR endpoint carries it, and it is `null` until GitHub computes it.
  Reading it off the list leaves a merge-conflict branch that looks alive and
  can never fire.
- **Hiding a control RETARGETS every selector that matched it by name**, and
  that is how v0.1.96 broke every real-prod loop while 1656 pure-fs
  assertions stayed green. `publishViaUi()` did
  `getByRole("button", {name: /^Publish$/i})`; `getByRole` skips CSS-hidden
  elements, so it skipped Decap's newly-hidden control and resolved to the
  PLATFORM's `#cms-publish-button` — same accessible name, different control.
  The click SUCCEEDED, opened the inline confirmation, and only the following
  `publish now` menuitem lookup failed. A missing control fails loudly; a
  silently retargeted one fails two steps later somewhere else. When a shim
  hides a control, audit what selects it by ROLE AND NAME, not just by class
  — and remember that the replacement is labelled with the right word for an
  editor, which is exactly what makes it a drop-in for someone else's
  selector. (v0.1.97, adamdaniel.ai run 33439336337.)
- **A browser `fetch()` of the GitHub API is answered from the HTTP cache
  for 60 s.** GitHub REST responses carry `Cache-Control: private,
  max-age=60` and Chromium honours it, so an admin shim that polls a URL
  reads the same body for a minute however often it asks — `refresh()` on
  `publish-progress.js` returned the pre-label snapshot 28 times in a row
  while the PR it described was already armed and merging (#386,
  adamdaniel.ai run 33580693718: every `/pulls` read answered in 1 ms, the
  first real one 58 s later). The tell is the timing, not the body: a
  GitHub round trip is 150–500 ms. Every GitHub GET under `theme/admin/`
  passes `cache: "no-cache"` (revalidation is free of rate limit) and
  `e2e/admin-github-fetch-cache.test.js` lints the shims for it; a harness
  that polls the page's own poller inherits the cache too, which is why a
  60 s arm wait failed over a publish that had succeeded.

→ read `docs/PUBLISHING-UX.md` before changing `theme/admin/`'s toolbar
shims, the status model, or any copy an editor reads. It carries the full
inventory, the measurements, and what each phase actually built.

### A required status check nobody publishes blocks forever, silently (#371)

`repo-settings.yml`'s `cms-feature-branches` required the context
`validate-content`. Nothing publishes that string. GitHub names a check run
after the JOB — `<job>` for a job with steps, `<caller job> / <called job>` for
a job that `uses:` a reusable — so the consumer's `editorial` caller of the
platform's `validate-content` job publishes `editorial / validate-content`,
which is how `consumer-main` spells it twenty lines earlier in the same file.

A required context that never reports never goes green, and a branch ruleset
does not time out. Every PR onto `cms/**`, `claude/**`, `feat/**`, … on BOTH
consumers was permanently `mergeable_state: blocked` — live since at least the
2026-07-10 fixture capture. It produced no signal because `bypass_actors`
grants admins `bypass_mode: always`: the only people who could merge never met
the wall, and merged by hand.

Three generalisations:

- **Lock a required context to the thing that would EMIT it, not to another
  list.** `cms-automerge-nudge.test.js` compares the nudge's
  `required_contexts` against `consumer-main` — two lists against each other,
  both free to name a context nothing publishes.
  `e2e/ruleset-context-publishable.test.js` is the missing join and is red
  against the tree as it stood.
- **A manifest defect is live even where it is not yet applied.**
  `audit-repo-settings.js --fix --yes` PUTs this file, so an unpublishable
  context in it becomes one live at the next reconcile.
- **`armed` is not "on its way".** An admin surface that reads a queued-to-merge
  signal and never asks whether the queue moves will report "Going live…"
  forever. The positive signal costs nothing and needs no timer: armed, at least
  one check run, none incomplete, nothing red, no conflict, no gate park, and
  still open ⇒ nothing left to wait for ⇒ the merge is not coming.
  `publish-progress.js` reports `settledSince`; the threshold lives in the pure
  `entry-status-model.js`, so both surfaces read one verdict.

One tool note that will bite any AST lint here: **acorn-walk does not descend
into the `property` of a non-computed `MemberExpression`.** A detector
collecting `Identifier` nodes cannot see `facts.armed` — the only spelling the
shim actually uses — so it finds zero decisions and passes. Walk
`MemberExpression` explicitly.

### A consumer's own post-build verifier runs through `site-verify.yml` (#377)

jodidaniel.com ships `scripts/verify-build-artifacts.rb` — ~190 assertions
over the BUILT site (media links resolve, the category triangle agrees, the
admin seam's anchors match built section ids, no PDF bytes are committed, the
`pdf_public` gate withholds and publishes). Its docs cited it in six places as
the guard for those; no workflow ran it, which is how a `pdf_public: true`
with no file in `_site` — row 2 of the verifier's own table — reached prod.
The consumer cannot own the workflow: workflow-SET parity flags any caller
absent from `examples/site/` as EXTRA on a required check. So it is a platform
seam: the `site-verify.yml` reusable plus a dictated thin caller of the same
name, which `platform-bump` seeds into both consumers on the next bump (#315).

Four decisions in it that are not obvious from the YAML:

- **Convention, not configuration.** No inputs, no secrets. If the caller's
  tree has `scripts/verify-build-artifacts.rb` the reusable builds the site
  (`JEKYLL_ENV=production`, the deploy's build, on deploy-preview's default
  Ruby) and runs it; otherwise it prints a `::notice::` and succeeds.
  adamdaniel.ai has no such script and no-ops in ~10s. Generalising to a
  non-Ruby verifier waits for a second case.
- **Work/gate split.** `verify` carries the wall; `site-verify` is the gate
  (`needs:` + `if: always()`, no `timeout-minutes`, no `concurrency`) — the
  #285/#289 shape, held by `e2e/site-verify.test.js` through
  `cancellationHazards()`. The context is `site-verify / site-verify`.
- **The caller has NO `paths-ignore`, deliberately.** The verifier globs
  `**/*.pdf` over the whole tree, so a docs-only PR can break it exactly as a
  layout PR can; a filter would blind the check for the ignored paths, and
  would arm the missing-check trap the moment the context is required (the
  `prerelease-guard` caller carries no filter for the same reason).
- **It became required only AFTER both consumers published it.** Adding a
  context to `consumer-main` before its publisher exists blocks every consumer
  PR on a context that never arrives (#371). So the order was: v0.1.98 release
  → `platform-bump` seeded the caller (jodidaniel.com#236, adamdaniel.ai#3464,
  both reported `site-verify / site-verify` green on 2026-09-01) → only then
  the manifest entry plus the nudge template's `required_contexts` line, and
  `e2e/site-verify.test.js`'s SEQUENCING guard flipped to its positive twin.
  Each consumer's own nudge list catches up on its next `platform-bump`, which
  reconciles it from the manifest (#315); until then the list is one context
  short, which GitHub's own merge refusal covers (#284's one-release window).

Measured before shipping: at jodidaniel.com `main`, `bundle exec jekyll build`
+ the script gives 192 `ok`, 0 `FAIL`, exit 0, identical under `JEKYLL_ENV=
production`; 9 `note` lines are assertion groups that do not arm while
`site_live: false`, so coverage roughly doubles at go-live (jodidaniel#26).

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

**#283 is NOT closed by shipping this.** The checker and the reusable are option
1's mechanism; option 1 lands when the seven repos actually carry the thin
caller. None does yet. The hand-mitigation #283 announced did land — re-measured
2026-08-20, all seven agree at `v0.1.87` — but the platform is at `v0.1.88` and
both consumers are already there, so the seven are a release behind again one
release later. Values fixed, mechanism unchanged.

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

## An unapproved gate holds its concurrency group, silently (#313)

`repo-settings-apply.yml` applied NOTHING for eleven days and nothing alerted.
Twelve consecutive runs concluded `cancelled`. The mechanism is worth knowing
before you write any workflow that pauses for a human:

- A run parked at an unapproved `environment:` gate is not finished, so it holds
  its concurrency group indefinitely. `cancel-in-progress: false` retains the
  holder plus only the LATEST pending run and cancels the rest — so with the
  group at WORKFLOW level, every later run dies without allocating a job.
- **Read the JOBS, not the run conclusion.** A cancelled run with
  `total_count: 0` from `/actions/runs/<id>/jobs` was cancelled while PENDING on
  a group; one with jobs was started and killed. Those are different bugs, and
  from the outside a run pending on concurrency looks exactly like a run waiting
  on a gate — which is how a correct head-of-line diagnosis got "refuted" here
  by a misread of run #22.
- So: **a job that can wait on a human gets no workflow-level group.** Scope it
  to the writing job, PER INDEPENDENT UNIT OF WORK, and let newest win — the
  newer run planned against newer `main`, and superseding a stale gate-park is
  the desired outcome, not a loss.
- The health audit could not see ANY of it, necessarily: `cancelled` is excluded
  from `BAD_CONCLUSIONS` because the runner-starvation carve-out is itself a
  cancelled shape. The lane that closes it never reads a conclusion at all — it
  alerts when a workflow that keeps firing has no recent SUCCESS.

**That "per independent unit of work" clause cost a second outage to learn.**
The #313 fix moved the group onto `apply` and left the name a CONSTANT — but a
job-level `concurrency` block applies to each MATRIX LEG separately, and `apply`
is a two-leg matrix (one per owner). Both legs joined one group and one killed
the other within a second, on every run, winner non-deterministic. Measured over
the next four runs: two killed the `jodidaniel` leg and parked `Adam-S-Daniel`
at the gate until the next day reaped it; two killed the `Adam-S-Daniel` leg and
a human approved `jodidaniel`, whose log reads `Fix plan: EMPTY`. So the leg
holding the fleet's only real drift never ran once, the drift re-armed the
prompt every morning, and the run CONCLUSION said `cancelled` even on days the
approved leg succeeded. Interpolate the axis: `group: <name>-${{ matrix.owner }}`.

**And the four approvals are the bigger lesson.** A gate that fires every
morning on routine, already-reviewed tightenings trains the reviewer to click,
and a reviewer who clicks is not reviewing — the request that mattered looked
exactly like the ones that did not. `repo-settings-apply` now gates only writes
that could REDUCE protection (`scripts/repo-settings-write-risk.js`, an
ALLOWLIST that fails closed), applies the rest unattended, enforces that at
WRITE time via `--refuse-weakening` rather than trusting the routing `if:`, and
FILES AN ASSIGNED ISSUE when a human genuinely is needed — closing it again when
the gate resolves, because an `environment:` gate is invisible unless you happen
to be looking at the Actions tab.

→ read `docs/CI-INVARIANTS.md` ("An UNAPPROVED environment gate must not hold a
concurrency group", and its three sequels) before adding a `concurrency` block
to any workflow with an environment gate, before widening or narrowing what the
write-risk classifier calls safe, or before touching `audit-scheduled-runs.js`'s
lanes.

## platform-bump moves files and one dictated input, not just pins (#315)

A release can require three kinds of consumer-side change, and for a long time
the bump made only the first: it re-pins, it SEEDS a newly-dictated thin caller,
it RETIRES one that left the canonical set, and it RECONCILES
`cms-automerge-nudge.yml`'s `required_contexts` from the manifest's ruleset for
that repo. The retire and reconcile halves have to ride the bump commit —
pin-consistency compares the consumer's workflow set against the platform at
that consumer's OWN pinned ref, so splitting either off fails in the
mirror-image direction (`MISSING` instead of `EXTRA`).

Two things to keep straight if you touch it: "was this caller ever dictated?" is
answered by the canonical set at the OLD ref, never by "the consumer has a file
we don't recognise" — that distinction is what stops it deleting site-authored
workflows — and the `required_contexts` list is DERIVED per consumer from
`repo-settings.yml`, never copied from the template, because a consumer may map
`main` to a different library entry.

Note also that the check reporting `workflow-set: EXTRA` is
`platform-pin-consistency / pin-consistency`, NOT `parity / parity` (that one is
`parity-preview.yml`'s preview gate). Only the latter is in `consumer-main`'s
required set today, so a stale or orphaned caller currently reports on an
OPTIONAL check.

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
