# Content publish latency: a focused lane for content PRs (shelved)

**Status: shelved by the owner on 2026-10-02, before any implementation.** No
code, workflow, ruleset or consumer change was made. This page is the record to
resume from: what was measured, the design the review arrived at, the
constraints a revival has to respect, and the defects found along the way that
are still live.

**Verification boundary.** The measurements, design and constraints below were
taken against cms-platform v0.1.122 on 2026-10-01. They are a historical record
of that tree, not a description of whatever `main` holds when you read this.
Later releases did touch files named here: v0.1.123
([#512](https://github.com/Adam-S-Daniel/cms-platform/pull/512)) re-pinned every
caller under `examples/site/.github/workflows/`, and v0.1.125
([#547](https://github.com/Adam-S-Daniel/cms-platform/pull/547)) taught
`platform-bump.yml` to seed missing delegating deploy wrappers. On 2026-10-03,
against `main` at v0.1.125 (`0c3b80c`), constraint 1 (`structuralShape()` still
excludes `on:`, and the bump still never edits an existing caller's `on:`
block), constraint 3 (`site_live: false`) and every row of the defect table were
re-checked by reading the source, and still held; nothing was built or run. The
defect table has since been brought up to date as of 2026-10-05 (v0.1.126
shipped the fixes for rows one, four and five; the consumers closed rows two
and three on 2026-10-04; row four's tracker,
[cms-platform#540](https://github.com/Adam-S-Daniel/cms-platform/issues/540),
stays open for consumer verification; see below). The baseline timings and the other
constraints were not re-measured; re-check them before relying on them.

Reviving this **reverses a recorded decision**:
[Rejected: skipping tests per diff](E2E-PARALLELISM.md#rejected-skipping-tests-per-diff).
Supersede that section explicitly; do not work around it.

## The proposal

Route a consumer PR by what it changes: content-only PRs run a small focused
check of the pages that change (phone, tablet, desktop: readable content,
working images and embeds, no unintended horizontal scroll) instead of the full
E2E matrix. Templates, styles, scripts and publishing/test machinery keep the
full matrix. The aim is wall clock from PR creation to the post being live.

## Measured baseline (2026-10-01, historical)

One real 3-line post,
[adamdaniel.ai PR 3941](https://github.com/Adam-S-Daniel/adamdaniel.ai/pull/3941):

| Stage | After PR open |
|---|---|
| Every required check except E2E green | 0m56s |
| `e2e / e2e` green ([run 36885094863](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/36885094863)) | 3m13s |
| Merged | 3m18s |
| Production deploy done ([run 36885515789](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/36885515789)) | 4m04s |

- 19 consecutive `cms/*` PRs on that repo (3929-3955): open-to-merge min 150 s,
  median 195 s, max 1104 s.
- E2E is the whole critical path, so the ceiling on the saving is about 2m15s
  per post.
- Per E2E job, 60-70 s passes before the first test: browser provisioning
  31-45 s, Ruby 7-9 s, the rest checkout and Node. The gate waits for the
  slowest of 14 jobs; one shard waited 37 s for its first step.
- A full-history checkout (`fetch-depth: 0`) costs 14-20 s on that repo; a
  shallow one 2-3 s.
- So a focused lane built the obvious way reports at roughly 1m50s-2m and saves
  about a minute, not two. The review set a budget of `e2e / e2e` within 90 s
  of PR creation at the median, measured on at least 10 real content PRs.

## The design to resume from

**Principle.** On a static site the pages a change affects are the built files
that differ between the base build and the head build. Select pages that way.
Do not model slugs, permalinks, tag archives, shared data or media references.
Proven on PR 3941: diffing the two `_site` trees gave exactly the new post,
`/blog/`, `/`, `feed.xml` and `sitemap.xml`; a build takes about a second.

**Router** (one pure module, table-tested):

- Input is the whole PR's net change on the merge ref:
  `git diff --name-status -z --no-renames HEAD^1 HEAD` from a `fetch-depth: 2`
  checkout. Never the last push; never the quoted `--name-only` form.
- `full` if any path is machinery or unrecognized, else `content` if any path
  is content, else `none`. An error is not a route and must fail the gate.
- Content set: `scripts/content-pr-guard.js`'s existing definition, read from
  the **base** tree so a PR cannot widen its own route. `none` set: today's
  `paths-ignore` list.
- Canaries (`_e2e/**`, `e2e-*` posts) take the content route, or the publish
  loops stop exercising the route real posts take.
- Do not escalate posts containing `<script>` to `full`: no full-suite test
  inspects that post, so it costs minutes and buys nothing.
- Lint the router against `visual-regression-salient.js` and
  `content-pr-guard.js` so the taxonomies cannot contradict each other.

**Topology and gate.**

- `e2e` stays the only required job name, with no `timeout-minutes` and no
  `concurrency`.
- No runner hop before the content checks start, at most one after; see
  [Rejected: generating the matrix from a setup job](E2E-PARALLELISM.md#rejected-generating-the-matrix-from-a-setup-job)
  for what a serial job costs.
- The gate is an explicit truth table in a tested module. `skipped` or
  `cancelled` where `success` is required fails. The lane asserts its executed
  test count equals pages times viewports; zero tests or any skip fails.

**Lane.** One job, Chromium, three viewports, no `decap-server`.

- Static checks: internal references resolve; nothing links a removed output;
  changed XML and JSON parse; no two source documents share a destination (a
  post with `permalink: /blog/` otherwise replaces a page and passes).
- Browser checks per changed page: main landmark visible and nonempty;
  document `scrollWidth - clientWidth <= 1` (needs no exception, an inner
  scroller does not widen the document); no author content past the viewport
  unless inside a scrolling ancestor that itself fits; images complete with
  `naturalWidth > 0` and no wider than their container after scrolling into
  view; iframes `https` with a nonzero fitting box; no uncaught page error.
- Third-party embeds are checked for layout and URL form only, never provider
  uptime.
- Before it gates, run the assertions over every existing page of both sites.
  `/` and `/blog/` change on every post, so one pre-existing failure there
  blocks all publishing.

**Rollout, three releases.**

1. The router and lane inside the reusable `e2e-tests.yml`; template and
   callers unchanged (stub and `paths-ignore` stay). Validate on a prerelease
   first. Ship the stub-retirement logic for step 3 here.
2. Gate-aware behavior for jodidaniel.com, the visual-regression skip for
   CMS-managed `_data` files, and a publication-boundary check in
   `site-verify.yml`.
3. Drop the stub and the `paths-ignore`, migrated by the bump logic shipped in
   step 1.

## Constraints a revival must respect

1. **One release cannot migrate the callers.** A consumer's bump runs the
   `platform-bump.yml` logic at its *current* pin. That logic retires a caller
   that left `examples/site/.github/workflows/` but never edits an existing
   caller's `on:` block, and `structuralShape()` in
   `scripts/check-platform-pin-consistency.js` excludes `on:` from drift.
   Dropping the stub from the template therefore deletes each consumer's
   `e2e-stub.yml`, leaves `paths-ignore` in `e2e-tests.yml`, and every
   docs-only PR waits forever on `e2e / e2e` with pin-consistency green.
2. **Paths must be NUL-delimited.** Default `git diff --name-only` quotes a
   non-ASCII path, leading quote included, so no `^_posts/` rule matches it.
   Two of adamdaniel.ai's five posts have such names. The salience readers
   now follow this (v0.1.126, row one of the defect table below), and the
   router must too.
3. **jodidaniel.com's gate is closed.** `site_live: false` on `main`: content
   edits change no public output, so a focused check there inspects a
   coming-soon page. The gate's location is declared as `cms.site_gate` in the
   site's `_config.yml`; build a scratch copy with it forced open to verify
   content.
4. **Builds are not byte-stable.** One tree built twice a few minutes apart
   differs in 7 files: `feed.xml`, `sitemap.xml`, `e2e/canary-page`,
   `e2e/canary-project`, a canary tag's page and feed, and
   `tools/claude-memory-map`. Pin time or always include them.
5. **`_site/e2e/` is legitimate.** The canary collection outputs to
   `/e2e/:slug/`, so a boundary check must test source paths, not `_site`
   directory names.
6. **Three path taxonomies already exist**: `e2e/select-specs.js`,
   `e2e/visual-regression-salient.js` and `scripts/content-pr-guard.js`. Reuse
   one; do not add a fourth.
7. **`_tools/**`, `assets/tools/**`, `assets/widgets/**` and
   `_data/tool_sources/**` stay on `full`** and keep their visual-review policy.
8. **The required contexts do not change**, so no ruleset edit is involved.

## Defects found that outlive the shelving

As of 2026-10-05 four of the five are fixed and one is open. The cms-platform
fixes shipped in v0.1.126
([#565](https://github.com/Adam-S-Daniel/cms-platform/pull/565) and
[#555](https://github.com/Adam-S-Daniel/cms-platform/pull/555)), and the two
consumer-owned defects were closed on 2026-10-04. The table below records the
state of each row; the trackers stay linked so the fix and its evidence have an
accountable destination. Two trackers are still open:
[cms-platform#540](https://github.com/Adam-S-Daniel/cms-platform/issues/540)
is waiting on consumer verification, and
[cms-platform#541](https://github.com/Adam-S-Daniel/cms-platform/issues/541)
tracks row five, whose fix shipped in v0.1.126 but whose issue is not closed.
Each defect stood on its own, with or
without the lane, and each has its own tracker in the owning repository
([cms-platform#529](https://github.com/Adam-S-Daniel/cms-platform/issues/529)
groups them).

| Defect | Where | Effect | Tracker |
|---|---|---|---|
| Quoted paths reach the salience check | `visual-regression.yml` `detect`, `e2e/detect-changed-pages.js` | A salient file with a non-ASCII name read as non-salient. Harmless in practice only because the affected names were under `_posts/`. **Fixed in v0.1.126 by [cms-platform#565](https://github.com/Adam-S-Daniel/cms-platform/pull/565):** both readers now take NUL-delimited paths (`git diff --name-only -z`), so accented, spaced, quoted and newline names classify correctly; so do `preview-media.yml` and `e2e/select-specs.js`, which shared the defect. | [cms-platform#539](https://github.com/Adam-S-Daniel/cms-platform/issues/539) |
| Site verifier is mostly unarmed | jodidaniel.com `scripts/verify-build-artifacts.rb` | With the gate closed, most assertion groups printed "did NOT run"; they ran only on a tree with `site_live: true`. **Fixed and closed 2026-10-04 by [jodidaniel.com#313](https://github.com/jodidaniel/jodidaniel.com/pull/313), which verifies the open-gate build too.** | [jodidaniel.com#306](https://github.com/jodidaniel/jodidaniel.com/issues/306) |
| Site verify is a no-op | adamdaniel.ai `site-verify` | The site had no verifier script, so the required check succeeded in about 7 s without building. **Fixed and closed 2026-10-04 by [adamdaniel.ai#4006](https://github.com/Adam-S-Daniel/adamdaniel.ai/pull/4006), a site-owned post-build verifier.** | [adamdaniel.ai#3970](https://github.com/Adam-S-Daniel/adamdaniel.ai/issues/3970) |
| No `table` or `iframe` rule | `theme/assets/css/main.css` | A wide Markdown table or fixed-width iframe scrolled the whole page on a phone, and an author could not fix it from the CMS. **Rule added by [cms-platform#555](https://github.com/Adam-S-Daniel/cms-platform/pull/555), released in v0.1.126. The tracker stays open: neither consumer has a built page with a bare Markdown table or a fixed-width iframe, so consumer verification rests on the platform fixture and the served CSS.** | [cms-platform#540](https://github.com/Adam-S-Daniel/cms-platform/issues/540) |
| Full-history checkouts on the critical path | `visual-regression.yml` `detect`, `parity-preview.yml`, `preview-media.yml` | 14-20 s each on adamdaniel.ai. They set the 56 s floor under every content PR, independent of E2E. **Fixed in v0.1.126 by [cms-platform#565](https://github.com/Adam-S-Daniel/cms-platform/pull/565):** a `fetch-depth: 2` checkout plus `e2e/ensure-merge-base.js`, which deepens only until the merge base is proven. Measured on adamdaniel.ai `pull_request` runs, three before (v0.1.125) and three after (v0.1.126), medians: `detect` 16 s to 9 s (checkout 10 s to 1 s, [before](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/37181483694/job/111374795291), [after](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/37185052769/job/111385134290)); `parity-probe` 28 s to 16 s (checkout 10 s to 1 s; noisy, the first runs took 69-71 s, [before](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/37181483680/job/111374795567), [after](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/37185052742/job/111385134369)); `media-probe` 19 s to 13 s (checkout 9 s to 1 s, [before](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/37181483634/job/111374795274), [after](https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/37185052774/job/111385134381)). jodidaniel.com was not measured. | [cms-platform#541](https://github.com/Adam-S-Daniel/cms-platform/issues/541) |

Also noted: neither consumer has a `tests/` directory, though jodidaniel.com's
deploy callers already list `tests/**`.

## Not verified

- No new assertion was run against either site, and jodidaniel.com was not
  built.
- Whether the publish loops depend on E2E job names.
- adamdaniel.ai's `admin/collections.site.yml` was not read.

## Re-measuring

Job and step durations: see
[Re-measuring](E2E-PARALLELISM.md#re-measuring). Open-to-merge for content PRs:

```bash
gh pr list --repo <owner>/<repo> --state merged --limit 80 \
  --json number,createdAt,mergedAt,headRefName --jq '
  [.[] | select(.headRefName | startswith("cms/"))
       | ((.mergedAt | fromdateiso8601) - (.createdAt | fromdateiso8601))]
  | sort | {n: length, min: .[0], median: .[(length / 2 | floor)], max: .[-1]}'
```
