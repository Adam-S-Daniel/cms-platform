# How the e2e suite is parallelised (and the measurements behind it)

`.github/workflows/e2e-tests.yml` runs the Playwright suite as **one CI job per
Playwright project**, each installing only its own browser engine and running at
150% of the runner's vCPUs. This page records what was measured, why the obvious
alternatives lose, and how to re-measure.

The machinery: **`e2e/ci-matrix.js`** (the matrix list, each job's engine, and
the worker count — all derived from `playwright.config.js`) and
**`e2e/ci-matrix.test.js`** (fails the platform's CI if the workflow's static
`matrix.project` drifts from the real project list — the one way this design can
silently stop running a project).

## The baseline it replaced

One job, whole suite, Playwright's default worker count, measured over 25
consecutive runs on adamdaniel.ai (2026-08-05 → 2026-08-07):

| | |
|---|---|
| `Run Playwright suite` step | **380–605 s** (typ. ~590 s) |
| `e2e / e2e` job | **510–740 s** (typ. ~680 s) |
| Tests | 844 total (678 ran, 166 self-skipped) |
| Workers | **2** — Playwright's default is 50% of cores, and a GitHub-hosted `ubuntu-latest` runner has 4 vCPU |
| Fixed overhead | ~80 s (browser install 45–74 s, Node 5 s, `npm ci` 2 s, Ruby+bundler 6 s, checkouts 3 s, artifact upload 3–11 s) |
| Site build | ~5 s (`bundle exec jekyll build --quiet`, inside the suite step via `webServer`) |

Where the time went, from one run's `--reporter=list` durations (run
31167638102, 936 s of reported test time):

| project | reported test-seconds | tests |
|---|---|---|
| `webkit-iphone16` (admin) | 329 | 65 |
| `chromium-desktop-3k` (admin) | 306 | 107 |
| the 8 public-page projects | 301 | 672 |

Two facts fall out of that table and drive everything below:

1. **The two admin projects hold ~65% of the wall clock in ~20% of the tests.**
2. **The public-page projects are the opposite** — 672 cheap tests whose cost is
   dominated by per-test overhead (browser context, screenshot, fixtures), not
   by test duration.

The projects also ran effectively **sequentially** (`chromium-desktop-1080`
0–39 s, `chromium-laptop` 40–64 s, … `webkit-iphone16` 429–595 s): with 2
workers both workers drain one project's queue before the next starts.

## Measured: workers, and why the first answer was wrong

The first experiment ran the 8 public-page projects together in ONE job and
compared worker counts:

| slice (one job) | 2 workers (default) | 4 workers (`100%`) |
|---|---|---|
| `chromium-desktop-3k` (admin) | 161 s | **128 s** |
| `webkit-iphone16` (admin) | 166 s | **132 s** |
| 8 public-page projects together | **263 s** | 284 s |

The public-page slice got *worse*, and the reported per-test durations doubled
(301 s → 641 s; `tags.spec.js` 99.8 s → 233.1 s). The obvious reading — "a
browser test burns more than one core, so a 4-vCPU runner saturates at 2
workers" — turned out to be an artifact of that 672-test, 8-project job shape.

Re-measured with **one project per job**, the picture reverses:

| project | 2 workers | 4 workers | 6 workers (`150%`) |
|---|---|---|---|
| `webkit-iphone16` | — | 165 s | **130 s** |
| `chromium-desktop-3k` | — | 156 s | 155 s |
| `chromium-desktop-1080` | 52 s | — | 53 s |
| `chromium-laptop` | 43 s | — | **28 s** |
| `chromium-mobile` | 33 s | — | **22 s** |
| `chromium-large-text` | 56 s | — | **39 s** |
| `chromium-light` | 54 s | — | **47 s** |
| `chromium-forced-colors` | 52 s | — | **42 s** |
| `firefox-desktop` | 31 s | — | 39 s |
| `webkit-tablet` | 54 s | — | 57 s |

A single project's tests are a MIX — roughly half of a public project's 91 tests
are pure-fs lints, and much of the browser half is spent *waiting* (Decap boot,
editor mount, page loads) rather than on CPU. Six workers is better or level
almost everywhere, and clearly better on the critical-path project.

**Therefore:** every project job runs at `150%` of the runner's vCPUs (6 on a
4-vCPU box), as ONE number rather than a per-project table — uniform measured no
worse than tuned, and a table is a thing to maintain. It is deliberately NOT a
blanket CI default in `playwright.config.js`: the other reusables
(`parity-preview`, `canary-prod`, the loops) run the whole matrix in one job —
exactly the shape where more workers measured worse.

**The lesson worth keeping:** measure the worker count on the job shape you
actually ship. The same tests, same runner, same worker count gave opposite
answers depending on whether one job ran 1 project or 8.

## Measured: `--shard` cannot balance this suite

Playwright's `--shard=i/N` balances by test **count**. Per-test durations here
span 5 ms → 49 s, so count is a useless proxy. Modelled against the measured
per-test durations (945 test-seconds total):

| split | per-shard test-seconds |
|---|---|
| `--shard=i/2` | 185 / 759 |
| `--shard=i/3` | 97 / 142 / 706 |
| `--shard=i/4` | 80 / 105 / 88 / **671** |

The last shard gets 71% of the work. Even *within* the public-page projects
alone (303 s), `--shard=i/2` measured 121 / 183.

**Therefore:** the split is by `--project`, which needs no duration bookkeeping
at all.

## Rejected: hand-grouped lanes

The first implementation grouped the projects into three lanes (each admin
project + one shared public lane). Modelled they looked perfectly balanced
(308 / 330 / 307 test-seconds); measured they were not — 220 s / 236 s / **373 s**
of job time. The public lane's 672 cheap tests carry far more per-test overhead
than their reported durations suggest, and at 4 workers that lane got slower
still. Any hand-tuned grouping also needs a cost table someone has to maintain.

**Therefore:** lane == project. It is the only split that needs no tuning, and
it makes each job's browser engine derivable — which pays for itself (below).

## Removed: a per-navigation screenshot nothing read

`e2e/base.js` captures a full-page screenshot on **every main-frame navigation
of every test** into `test-results/per-test-frames/`. Its only consumer is
`e2e/generate-test-videos.js`, which no reusable invokes (the adamdaniel-only
`finalize` job that assembled the videos was deliberately not ported). So every
navigation was paying for frames nothing reads — worst on the link-crawling admin
specs, which navigate dozens of times inside one test. The reusable now sets
`DISABLE_PER_TEST_VIDEOS=1`; `screenshot: "on"` and `video: "retain-on-failure"`
still produce the artifacts a red run is actually diagnosed from. Unset it
locally to get the frames back.

## Rejected: caching the browser install

`npx playwright install --with-deps` for all three engines measured **58 s**:
39 s of `apt-get` + 19 s of downloads. Caching `~/.cache/ms-playwright` would
only remove the 19 s (minus cache-restore time), and cannot touch the apt half.
Installing **one** engine per job removes most of both, needs no cache key, and
cannot go stale. `e2e/install-browsers-on-miss.js` reads `PW_PROJECT` so the
runtime self-heal checks only the engine in play — otherwise it would
re-download the two engines the scoped install just skipped.

## Rejected: skipping tests per diff

`e2e/select-specs.js` can narrow the suite to a diff's salient specs, and the
platform deliberately does not use it in `e2e-tests.yml`: the goal here is to
run the *same* coverage faster, not to run less of it. Selection trades coverage
for speed and adds a "did the selector miss something?" failure mode; the
project matrix needs no such trade.

## Three isolation bugs that parallelism exposed

Running the admin projects wider surfaced three genuine pre-existing test bugs.
All are fixed; all would have bitten eventually at any worker count.

* **Shared upload basename.** `cms-image-upload`, `manual-walkthrough-first-post`
  and `cms-featured-image-lifecycle` all handed Decap the same
  `e2e/fixtures/tiny-pixel.png` and then globbed `assets/images/uploads/` for
  that basename — so one spec's cleanup deleted another's in-flight upload
  ("replace with B → A still on disk" saw 0 files). Each spec now uploads under
  its own basename via `e2e/upload-fixture.js`.
* **An unbounded crawl on a fixed budget.** `image-alt-text.spec.js` visits
  *every* sitemap URL inside one test, on Playwright's fixed 30 s default — it
  already used ~21 s of that at 2 workers, so it timed out as soon as its
  project ran wider. Its budget now scales with the URL count, matching
  `cms-link-crawler.spec.js`'s explicit crawl budget.

* **A shared `jekyll build`.** Nine specs shell out to `bundle exec jekyll build`
  against the same tree and the same `_site` the webServer serves. Jekyll cleans
  `_site` then regenerates it, so two builds in flight together fight and one
  dies (`Error: Command failed: bundle exec jekyll build --quiet`). They now go
  through `e2e/jekyll-build.js`, which serialises them behind an atomic mkdir
  lock keyed on the site root — cross-process, because Playwright workers are
  separate processes. It costs the write-heavy admin project ~30 s and removes
  the class; `e2e/jekyll-build.test.js` proves the lock holds, releases on a
  failed build, breaks a stale one, and that no spec builds directly any more.

The lesson worth keeping: **a test whose budget doesn't scale with its input,
whose fixture is shared with another spec, or which drives a shared external
tool, is a latent flake that parallelism converts into a real one.**

## The result

| | before | after |
|---|---|---|
| shape | 1 job, 2 workers, all 10 projects | 10 jobs, 1 project each, `150%` workers |
| engines installed per job | 3 | 1 |
| workflow wall clock | ~680 s | ~215 s |
| required status context | `e2e / e2e` | `e2e / e2e` (unchanged — the matrix sits behind an aggregating gate job) |

The floor is now the slowest single project (`webkit-iphone16`: ~130 s of tests)
plus ~60-70 s of fixed cost. Cutting it further means attacking
`cms-link-crawler`'s ~50-66 s single test, or `--shard`ing *within* that one
project — both of which buy less than they cost today. The fixed cost is already
mostly irreducible: ~25 s of runner + checkouts + Node + `npm ci`, ~20-35 s of
`playwright install --with-deps <engine>`, ~5 s of `jekyll build`, and ~15 s of
Playwright's own start-up and spec collection.

## Re-measuring

The per-project job durations are in the run's job list, and the per-test
durations are in each job's `--reporter=list` output:

```bash
# job + step durations for a run
gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | {name, started_at, completed_at, steps: [.steps[] | {name, started_at, completed_at}]}'

# per-test durations for one project job
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs | grep -E '✓|✘'
```

To try a different worker count without cutting a release, pass the reusable's
`workers` input (it overrides every job): `workers: "2"`. To change the policy
permanently, edit `ADMIN_WORKERS` / `workersFor()` in `e2e/ci-matrix.js`.
