# How the e2e suite is parallelised (and the measurements behind it)

`.github/workflows/e2e-tests.yml` runs the Playwright suite as **one CI job per
Playwright project** — except the two admin projects, which run as three
`--shard` jobs each — every job installing only its own browser engine (from an
apt `.deb` cache seeded on the default branch) and running at 150% of the
runner's vCPUs. This page records what was measured, why the obvious
alternatives lose, and how to re-measure. The two newest sections, [The apt
tail, and the .deb cache that removes it](#the-apt-tail-and-the-deb-cache-that-removes-it-2026-09-30)
and [Revisited: a 3-way shard of the admin projects only](#revisited-a-3-way-shard-of-the-admin-projects-only-2026-09-30),
supersede the "stop here" conclusion further down.

The machinery: **`e2e/ci-matrix.js`** (the matrix entries, each job's engine,
the admin-project shard count, and the worker count — all derived from
`playwright.config.js`) and **`e2e/ci-matrix.test.js`** (parses the workflow and
fails the platform's CI if its static `matrix.include` drifts from
`matrixEntries()` — the one way this design can silently stop running a project
or a shard).

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
blanket CI default in `playwright.config.js`: the sibling reusables
(`parity-preview`, `canary-prod`, the loops) each run a handful of specs pinned to
one or two projects in a single job — a shape this number was never measured on,
and often a single serial `@admin-write` round trip that more workers cannot
speed up. The override is opt-IN per lane.

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
at all. (This is about sharding the WHOLE suite, and it still holds. Sharding
*within* the two admin projects is a different shape and was measured
separately in 2026-09 — see [Revisited: a 3-way shard of the admin projects
only](#revisited-a-3-way-shard-of-the-admin-projects-only-2026-09-30).)

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
cannot go stale.

**Re-measured 2026-09-30, still rejected.** Over 700 consumer project jobs (the
last 35 e2e runs on each consumer) the browser-download phase was **9.5 s at the
median, 11 s at p90 and 17 s at the max**, with **zero** download retries. There
is no tail here to remove. The slow half was, and is, apt — which the `.deb`
cache below now addresses. `e2e/install-browsers-on-miss.js` reads `PW_PROJECT` so the
runtime self-heal checks only the engines in play — otherwise it would
re-download the ones the scoped install just skipped.

That self-heal turned out to be re-downloading engines on **every other lane
too**, and had been since those lanes existed: each installs chromium only (and
self-CI's lint lane installs nothing), while the blanket check reported the rest
as missing and fetched them — for engines the run never launches, printing the
"ci-runner image is drifting" warning every time, which made a real drift
indistinguishable from the permanent false one. Evidence: adamdaniel.ai
canary-prod job 92842548516 ("missing … firefox, webkit" + two downloads on a
chromium-only lane) and cms-platform self-ci job 92855380065 (all three
downloaded, ~16 s, before running pure-fs lints). Every harness-running step now
declares the projects it runs via `PW_PROJECT`, and
`e2e/engine-scope-lint.test.js` fails if one forgets — including the two REQUIRED
per-PR checks, `parity / parity` and `preview-media / preview-media`.

## The download is bounded and retried; apt is retried but never bounded (a slow mirror once cost 39 minutes)

Fanning out multiplies infrastructure exposure: ten lanes take ten *independent*
`apt-get install` trips through the Ubuntu archive, and the aggregating `e2e`
gate waits for the slowest of them. On 2026-08-07 that bill came due —
adamdaniel.ai run 31177527405, job 92862768030 (`webkit-tablet`):

| phase | duration |
|---|---|
| `npx playwright install --with-deps webkit` (combined, pre-split) | **39 min** |
| the tests it installed for | **41.6 s** (75 passed) |

Nothing was broken. `azure.archive.ubuntu.com` served that one runner at
~35 KB/s for the whole run — every package fetch stalling 86-391 s across ~90
system packages — and at the time the install had **no bound and no retry at
all**, so it simply took as long as the mirror wanted. The other nine lanes
finished in 80-200 s.

**And it is not rare.** A second run 67 minutes later, on a different lane, did
the same thing — adamdaniel.ai run 31181957723, `chromium-mobile`: **606 s** in
the install step, **20 s** of tests, while its nine siblings finished in 70-216 s.
Two hits in the same afternoon, so budget for this happening on the order of one
run in ten, not once a quarter. With ten lanes per run that is the arithmetic you
would expect from a ~1% per-lane stall rate — fanning out did not cause the
stalls, it just gave them ten chances per run to become your critical path.

What made it expensive is what waits on the gate. A `cms/*` canary PR cannot
merge until `e2e / e2e` reports, so that lane held delete-recovery PR #2953 open
for 40 min and blew `cms-media-roundtrip.spec.js`'s 30-minute delete-leg budget —
the loop failed on a green test suite. Read the loop's own error and you would
chase the deploy chain; the cause was three workflows away.

The fix went through two designs. The first bounded and retried the WHOLE
combined `install --with-deps` call. The current one — in
`.github/actions/install-playwright-browsers`, used by every lane that installs
browsers — splits that call into `install-deps` (apt) and `install` (the
browser download, no `--with-deps`) and bounds **only** the download.

**Why apt is retried but never wrapped in `timeout` (job 92989057569).** The
first design's uniform bound looked right and was wrong: it did not abandon a
slow apt, it *orphaned* one. `timeout` signals only the process it directly
launches, but Playwright logs "Switching to root user to install
dependencies..." before it shells out to apt — the `apt-get` doing the real
work is a **root-owned grandchild**. An unprivileged `timeout` cannot deliver a
kill signal to a root-owned process (EPERM), no matter how the process group is
arranged, so `setsid` plus a group kill is not a fix either — **no
signal-based kill can work here**, because the blocker is privilege, not
process grouping. Measured on adamdaniel.ai job 92989057569:

```
20:26:26  attempt 1's apt starts fetching (bound 420s) — ZERO lock-wait lines; it owned the lock
20:33:25  attempt 1 killed at the bound (exit 124), mid-transaction
20:33:44  attempt 2: "Could not get lock /var/lib/dpkg/lock-frontend.
                      It is held by process 2857 (apt-get)"   -> eventually exit 100
```

No lock contention existed before the kill; it appeared 19 seconds after — pid
2857 was attempt 1's own killed-but-surviving `apt-get`, not the runner's
boot-time `apt-daily`. Every later attempt starved on that same orphan. So
`install-deps` now runs with **no `timeout` around it at all** — it is still
retried (a transient dpkg-lock race or mirror hiccup that makes the command
itself exit nonzero gets another attempt), but nothing ever sends it a kill
signal. This is not a reversion to the pre-fix state above: apt IS genuinely
the slow phase (this incident's 39 minutes was package fetches, not the CDN),
so the trade is deliberate — one lane can still finish late, and
late-and-green beats red-and-blocked, because a red required check blocks a
`cms/*` canary PR permanently instead of merging it late. A genuinely hung apt
is now bounded only by the caller's own job `timeout-minutes`, where "job
timed out" is an accurate report rather than the misleading one a
killed-but-orphaned apt used to produce. `npx playwright install` also wraps
apt's exit 100 as exit 1, so the outer exit code was never diagnostic on its
own; classification greps the captured output for `Could not get
lock|lock-frontend|dpkg was interrupted` before looking at the exit code, so a
lock failure on the (unbounded) apt phase is never misreported as a timeout.

**The download half (`install`, no `--with-deps`) keeps the bound-and-retry
design:**

- **Bound:** each download attempt runs under `timeout 420` (~7x the normal
  ~60 s install, so a healthy mirror never trips it).
- **Retry, with an ESCALATING budget:** up to 3 attempts — the early ones bounded
  at 420 s to abandon a stalled connection fast, the **last** one at 1200 s so it
  can actually finish. Two wrong designs to avoid: a bare `timeout-minutes:` turns
  "slow mirror" into a RED required check, which blocks the canary PR permanently
  instead of merging it late; and a *uniform* retry bound does the same thing when
  the mirror is slow for the whole run (the measured case needed 2340 s, so three
  420 s attempts would all hit the bound and exit 1). The download resumes —
  downloaded engines stay in `~/.cache/ms-playwright` — so the attempts
  accumulate progress and the final one only has to finish what is left. apt's
  own `Acquire::*::Timeout` does not help here either: the bytes were flowing,
  just slowly.
- **Bounded by the JOB, too:** the worst case must stay under the caller's
  `timeout-minutes`, or GitHub kills the job mid-retry and the run reports an
  opaque "job timed out" instead of the action's diagnostic. `canary-prod`'s
  10-minute probe job therefore passes smaller values, and `parity-preview` /
  `preview-media` (30 min) cap the final attempt at 900 s.
- **Loud:** each retry logs `::warning::` with the attempt number and whether it
  hit the bound (exit 124) or failed for real, so the log says which it was.

**apt still WAITS for the dpkg lock — a separate concern from the timeout
question above.** The most common apt *failure* (not slowness) is losing the
race for `/var/lib/dpkg/lock-frontend` to the runner's own boot-time
`apt-daily`, which exits **100** — contention with a process we don't control,
unlike the self-orphan case above. Measured: job 92892148211's webkit lane
failed that way, failed the `e2e` gate, BLOCKED the host loop's canary PR, and
the loop then timed out waiting for a merge that could never happen — a loop
failure three workflows from its cause. A retry alone cannot fix it
(back-to-back attempts land in the same lock window), so the action drops
`DPkg::Lock::Timeout` into `apt.conf.d`, which is the only way to reach the
apt-get *inside* `playwright install-deps`, and **backs off** 15 s / 30 s
between attempts on both phases.

`e2e/playwright-install-bounded.test.js` fails self-CI if any workflow goes back
to a raw `npx playwright install`, and asserts the download phase still bounds
and retries while the apt phase is retried but never wrapped in `timeout`.

**Worst case for the download is now ~21 min instead of unbounded; apt's worst
case is bounded only by the job's own `timeout-minutes`** — and in the
observed case the second attempt would have finished in the usual minute.

## The apt tail, and the .deb cache that removes it (2026-09-30)

The bound/retry work above stops a slow mirror from turning a lane RED. It
cannot make one fast, and by September the slow mirror was the gate's tail.

**Measured** — the last 35 e2e runs on each consumer (700 project jobs), with
each job's install step split from its log into `apt-get update`, the archive
fetch (`Need to get` → `Fetched`), dpkg, and the browser download:

| phase | median | p90 | max |
|---|---|---|---|
| install step (whole) | 26-27 s | 48-50 s | **1583 s** |
| `apt-get update` (index) | 6 s | 11 s | 28 s |
| apt archive **fetch** | 2 s | 12-15 s | **1558 s** |
| dpkg unpack/configure | 6 s | 14 s | 63 s |
| browser download | 9.5 s | 11 s | 17 s |

Payload per engine: chromium 32-35 MB, firefox 49-52 MB, **webkit 114-130 MB**.
Every one of the 17 lanes over 80 s of install was the archive fetch from
`azure.archive.ubuntu.com` at ~83-100 KB/s, and they cluster: the last six
adamdaniel.ai runs of 2026-09-30 (17:35-18:27Z) ALL stalled, gates 380-1662 s.
`e2e / e2e` wall clock: adamdaniel.ai **225 / 492 / 1662 s** (median / p90 /
max), jodidaniel.com **166 / 219 / 598 s**.

**What it cost.** adamdaniel.ai run 36753770616, job 110018693124
(`webkit-tablet`): `Fetched 130 MB in 25min 58s (83.2 kB/s)`, attempt 1, no
retry, then 48 s of tests. Its canary PR #3921 could not merge until the gate
reported, so scheduled host-loop run 36750741941 (job 110008498285) failed at
its 40-minute budget in `waitForChangeReflected` — a green suite, a red prod
loop, three workflows from the cause. That is the same coupling the 2026-08-07
incident above describes, and the fetch is its entire mechanism.

**The design.** `.github/actions/install-playwright-browsers` restores apt's
downloaded `.deb`s from `actions/cache`, copies them into
`/var/cache/apt/archives`, and then runs the apt phase exactly as before —
unbounded, retried, waiting on the dpkg lock. apt finds every archive already
on disk ("Need to get 0 B/32.1 MB") and fetches nothing; it still verifies each
file against the signed index it just fetched, so a stale or corrupt entry is
re-downloaded, never installed. None of the apt invariants above move: nothing
is killed, nothing is bounded, nothing new takes the lock.

- **Key:** `playwright-apt-debs-v1-<ImageOS>-<engine>-pw<version>-<ImageVersion>`
  — the runner image decides what apt diffs against, the engine and Playwright
  version decide the package list. The restore falls back to the newest entry
  for the same engine + Playwright, then the same engine. Measured across an
  image rotation: a `20260920.314.1` entry restored on a `20260927.320.1`
  runner left **4.3 MB of 130 MB** to fetch.
- **Only the default branch saves.** A pull-request run's cache entry is scoped
  to that PR and unreadable by every other PR — and 18 of the 21 `cms/*` canary
  branches in the sample got exactly **one** e2e run. A PR-scoped save would
  protect nobody while spending ~0.2 GB of the repo's 10 GB cache budget per PR
  (adamdaniel.ai opens ~26 a day). The saved set is pruned to the versions
  actually installed, so it does not accrete superseded `.deb`s across images.
- **Seeding:** the loops that already run on main seed chromium as a side
  effect; nothing on main installs firefox or webkit. So consumers call
  **`warm-e2e-apt-cache.yml`** daily (+ `workflow_dispatch`): one job per engine
  from `node e2e/ci-matrix.js --engines`, apt phase only (`deps-only`), no
  tests, no secrets, `contents: read`. Cost: three ~40 s jobs a day per
  consumer on a hit, or a mirror fetch's worth on the day an image rotates.
  Cache footprint: ~215 MB per consumer (one entry per engine per image).
- **Fail-open everywhere:** a miss, a failed restore, a failed seed or a failed
  save is exactly the pre-cache mirror fetch.

**Validated** on real CI, consumer draft PRs pointed at the branch commit
(adamdaniel.ai run 36762325363, 7 attempts; jodidaniel.com run 36763337967, 6
attempts; the first attempt of each is the miss that populated the cache):

| | adamdaniel.ai gate | jodidaniel.com gate |
|---|---|---|
| baseline (35 runs, v0.1.117-118) | 225 / 492 / 1662 s | 166 / 219 / 598 s |
| cache MISS, same afternoon | 434 s (a 352 s fetch) | **1486 s** (a ~22 min fetch) |
| cache HIT (n=6 / n=5) | **218 / 249 / 257 s** | **165 / 168 / 170 s** |

On a hit the install step is 26-28 s at the median (restore ~1.5 s, update
6 s, dpkg 6-14 s, download ~5-10 s) — about the same as a healthy baseline
install, which is the point: the median barely moves, the tail disappears.
The misses in the table are the live control: the mirror was slow that
afternoon, and only the cached lanes did not notice.

## Rejected: the official Playwright container (2026-09-30)

Running each project job in `mcr.microsoft.com/playwright:v1.63.0-noble`
(digest-pinned) would remove apt and the download entirely. Measured on a
10-wide probe matrix: **"Initialize containers" 24-40 s, median 27 s** — the
same as today's healthy install (26 s), so the typical run gains nothing, and a
956 MB (compressed) pull from MCR is a tail of its own. It also does not fit the
local lane: the image ships no ruby, gcc, make, sudo or gh (the lane needs
Ruby + Bundler, and native gems build on a bundler-cache miss — apt again), its
Node is 24 against the harness's 20, and inside a container
`${{ github.workspace }}` renders the HOST path, which breaks the `SITE_ROOT`
wiring `e2e/loop-site-root-lint.test.js` locks. (The adamdaniel-only GHCR
`ci-runner` image was dropped from the platform port for the same kind of
reason — see docs/CI-INVARIANTS.md.) The `.deb` cache removes the same tail for
a fraction of the change.

## Revisited: a 3-way shard of the admin projects only (2026-09-30)

"Where the remaining time actually goes" below priced sharding and stopped.
Two things changed, and one part of that argument was wrong.

**What changed.** `chromium-desktop-3k` grew from 104 s to **~151 s** of tests
and now ties `webkit-iphone16` (~150 s) as adamdaniel.ai's pole; every public
project is ≤ 50 s. In the 35-run sample those two projects ended last in 31 of
35 adamdaniel.ai runs and 34 of 35 jodidaniel.com runs — with the apt tail
cached, they are the whole critical path.

**What was wrong.** Sharding only the admin projects is **14 jobs, not 20**,
and it adds **no** dimension to any consumer's required check: the matrix is an
`include` list behind the same aggregating `e2e` gate, so rulesets and the
`e2e-required-stub` still name exactly `e2e / e2e`, and consumers change
nothing. The count-balance objection is real for the whole suite and is
measured, not assumed, here: within one admin project the tests are of similar
weight, apart from webkit's ~90 s `cms-link-crawler` crawl.

**Measured** (the `.deb` cache plus `--shard=i/3` of each admin project;
adamdaniel.ai run 36763299356, jodidaniel.com run 36764818854, 6 attempts each,
first attempt the cache miss):

| | adamdaniel.ai | jodidaniel.com |
|---|---|---|
| gate, cache hit, 10 jobs (above) | 218 / 249 / 257 s | 165 / 168 / 170 s |
| **gate, cache hit, 14 jobs** (n=5 each) | **158 / 162 / 163 s** | **142 / 189 / 208 s** |
| admin shard suites | 40-72 s (vs 120-146 s whole) | 17-60 s (vs 72-98 s whole) |
| runner-seconds per run | 1054 → **1357 (+29%)** | 910 → **1158 (+27%)** |
| tests | shard sums equal the unsharded totals (116 = 39+39+38; 70 = 28+19+23) | (101 = 35+33+33; 64 = 28+18+18) |

jodidaniel.com's p90/max is one attempt whose runners allocated late; its
median is the honest figure. **Why 3, not 2:** modelled from per-test
durations, a 2-way split leaves webkit-iphone16's crawl in shard 1 finishing at
~139 s — no better than unsharded — so 2-way was not worth measuring; 3-way puts
the new pole at the crawl's shard (~72 s of tests). **Why not the public
projects:** they are not the pole, and each shard re-pays the ~45 s fixed
per-job cost. The rule is derived — `isAdminProject` × `ADMIN_SHARDS` in
`e2e/ci-matrix.js` — never a per-project table, and a shard with no matrix
entry is a red `ci-matrix.test.js`.

**Re-check before changing it:** if a public project's suite ever exceeds the
slowest admin shard, the pole has moved and the shard count buys nothing more;
if an admin shard's suite exceeds ~100 s, consider `ADMIN_SHARDS = 4`.

## Rejected: skipping tests per diff

`e2e/select-specs.js` can narrow the suite to a diff's salient specs, and the
platform deliberately does not use it in `e2e-tests.yml`: the goal here is to
run the *same* coverage faster, not to run less of it. Selection trades coverage
for speed and adds a "did the selector miss something?" failure mode; the
project matrix needs no such trade.

A 2026-10 proposal to route content-only PRs to a focused lane would have
reversed this. It was shelved before implementation; the measurements, design
and live defects it turned up are in
[`CONTENT-PUBLISH-LATENCY.md`](CONTENT-PUBLISH-LATENCY.md).

## Rejected: generating the matrix from a setup job

`matrix.project` in `e2e-tests.yml` is a STATIC list, kept honest by
`e2e/ci-matrix.test.js` (self-CI fails if it drifts from the project list
`playwright.config.js` actually declares). The obvious "simplification" is to
delete the lint and have a setup job emit the list via
`fromJSON(needs.setup.outputs.projects)` — GitHub supports it, and it makes drift
structurally impossible instead of merely lint-caught.

It is rejected because it puts a **serial job on the critical path of every run**.
A setup job cannot start the matrix until it finishes, and a job's floor here is
not its script — it is runner allocation + checkout + Node setup, i.e. most of the
~42 s fixed cost measured above. Paying ~30-40 s on a ~200 s run, on every PR,
forever, to avoid a drift the lint already catches at PR time is the wrong trade
for a change whose entire purpose is wall clock.

The lint is also the stronger guard in the way that matters. A dynamic matrix
would silently run whatever the config declares — so deleting a project by
accident would produce a green run with less coverage. The static list plus the
lint makes removing a project a deliberate, reviewable two-file edit, and a
one-file mistake goes RED.

Revisit only if the project list starts changing often enough that the two-file
edit is real friction. It has changed twice in the platform's life.

(`warm-e2e-apt-cache.yml` DOES derive its engine matrix from a setup job
running `node e2e/ci-matrix.js --engines`. That is the same trade made the other
way for a different job: the seeder is off every critical path and gates
nothing, so the serial job costs nobody a wait, while a static engine list
there would be one more thing to forget when a project changes engine.)

## Isolation bugs that parallelism exposed

Running the admin projects wider surfaced genuine pre-existing test bugs. All
are fixed; all would have bitten eventually at any worker count — one is
literally the race the config's `retries: 1` was added for.

Two rounds of them, which is the more useful lesson: the first round was found by
CI going red, the second by an adversarial review of the first round's own fixes.
Widening concurrency does not create these bugs, it just stops hiding them, so
expect to find them in layers.

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
  the class. Waiting for the lock is **credited back to the caller's test
  timeout** so the fix can't trade the build race for a timeout race (these specs
  run on Playwright's 30 s default and a build is ~4 s).
  `e2e/jekyll-build.test.js` proves the lock holds, releases on a failed build,
  breaks a stale one, credits the wait, and that no spec builds directly.

* **Reading a file another process is writing.** Specs waited with
  `expect.poll(() => fs.existsSync(file))` and then read — but decap-server
  CREATES the entry file and then fills it, so the poll can win and hand the
  spec `""` (`Expected substring: "title: …" / Received string: ""`). They now
  poll the CONTENT via `e2e/fs-poll.js` — `contentOrEmpty()` for a fixed path,
  `fileReady(<finder>)` when a readdir helper discovers it.

  **Round 2 caught six more, two of them worse than an assertion failure.**
  The first pass converted five specs; `cms-html-embed`, `cms-inline-image`,
  `cms-publish-flow`, `cms-image-upload`, `manual-walkthrough-first-post` and
  `cms-scheduled-post` kept the old shape. In `cms-html-embed` and
  `cms-inline-image` the read feeds a `writeFileSync` back to the same path, so an
  empty read did not fail an assertion — it **overwrote the entry with
  front-matter-less content** and left a corrupt Jekyll page for the retry's
  `beforeAll`. `e2e/fs-poll-lint.test.js` (AST) now fails the build on the shape,
  so the rule is enforced rather than merely documented. An existence poll for a
  file the spec never READS is legitimate and is not flagged.

* **A missing tag is silent.** `cms-html-embed.spec.js` drives
  `/admin/index-local.html`, creates a post through Decap and rebuilds Jekyll —
  but carried NO `@admin-*` tag. An untagged test matches every public project's
  `grepInvert`, so that Decap write ran on all EIGHT public-lane projects
  (firefox and webkit included) for a contract that is server-side and
  engine-independent. Tagging is now `@admin-write`, and
  `e2e/admin-tag-lint.test.js` fails on any spec that navigates the admin shell
  without an admin tag.

The lesson worth keeping: **a test whose budget doesn't scale with its input,
whose fixture is shared with another spec, which drives a shared external tool,
which reads a file another process is still writing, or which forgets the tag
that routes it, is a latent flake (or a silent 8x) that parallelism turns real.**


* **...and so is a tag that contradicts a hand-rolled gate.** Tagging
  `cms-html-embed` `@admin-write` routed it to `chromium-desktop-3k` — while its
  own `beforeEach` still skipped unless the project was `chromium-desktop-1080`.
  Mutually exclusive, so the file skipped **everywhere** and the kramdown render
  contract stopped being tested, with nothing red to show it. (The same gate also
  means the original "it ran on all eight public projects" claim overstated the
  harm: the gate had kept it to one. Tagging was still right — the tag expresses
  the routing the gate was hand-rolling — but the gate had to go with it.)
  `e2e/admin-tag-lint.test.js` now computes which projects a spec's tags route it
  to, from the config's own `grep`/`grepInvert`, and fails if a hand-rolled
  `project.name !== "…"` gate cannot be satisfied. **A skipped test is invisible
  in a green run, so this class has to be a lint.**
* **The build lock's stale break was unreachable, and its release was unowned.**
  Two defects in the lock above, found by reviewing it rather than by a red run.
  (a) `WAIT_TIMEOUT_MS` was 180 s and `STALE_MS` 300 s — but a waiter breaks a
  lock only once it is *older* than `STALE_MS`, so a fresh waiter always died
  first: a killed worker's lock wedged the next build into `timed out waiting for
  the build lock`, the precise opposite of the guarantee the file documents. The
  inequality is now enforced by a test, not by two constants that happened to be
  in the right order. (b) Breaking a lock was unowned, so a merely-slow holder
  could have its lock broken, a second build start, and the original's `finally`
  then delete the NEW holder's lock. The lock dir carries an `owner` token now;
  `release` refuses to remove a lock that is not ours, and the break re-reads the
  owner before acting.

* **An orphaned `<loc>` in the shared sitemap.** `cms-page-crud` builds
  `/pages/decap-page-crud-smoke/` into the shared `_site/sitemap.xml`, then its
  cleanup deletes the rendered directory without pruning the sitemap — and
  `image-alt-text.spec.js`, in the same job and the same `_site`, walks every
  sitemap URL with a hard 200 assertion. The five sibling smoke posts get away
  with it because they live at `/blog/e2e-…/` and the crawl exempts that fixture
  slug signature; `blogSlugFromPath` returns null for `/pages/…`, so this one was
  not exempt. It now prunes, exactly as `cms-publish-flow` already did for its own
  entries.

## The result

Measured on both consumers' own v0.1.68 bump PRs — i.e. the released code, not a
branch:

| | before | after |
|---|---|---|
| shape | 1 job, 2 workers, all 10 projects | 10 jobs, 1 project each, `150%` workers |
| engines installed per job | 3 | 1 |
| **adamdaniel.ai** wall clock | 510–740 s (typ. ~680 s) | **199–256 s** (v0.1.68 bump 222 s; v0.1.70 bump 202 s slowest lane) |
| **jodidaniel.com** wall clock | 376–453 s | **148–210 s** (v0.1.68/69 bumps 148/150 s; v0.1.70 bump 210 s) |
| flaky tests in the final config | — | 0 across the last two runs |
| required status context | `e2e / e2e` | `e2e / e2e` (unchanged — the matrix sits behind an aggregating gate job) |

**What it costs:** runner-minutes go UP, because ten jobs each pay the fixed
setup. adamdaniel.ai: ~680 runner-seconds in one job before, ~1050 across eleven
after — about 1.5x the runner time for ~3x less wall clock. That is the trade
this design makes deliberately; if runner minutes ever matter more than latency,
the lever is fewer, bigger jobs (and a cost table to balance them), not fewer
workers.

**The spread is real — quote the range, not the best run.** jodidaniel.com
measured 148 s, 150 s and 210 s on three consecutive bump PRs of the same suite.
The difference is almost entirely per-lane install variance (its `webkit-iphone16`
install ranged 29-61 s on those runs) plus runner allocation, not test time. So
treat "~150-210 s" as the honest figure for a single-page consumer and
"~200-220 s" for a full one, and don't read a 20% swing between two runs as a
regression.

**Variance to expect:** the wall clock includes GitHub allocating ten runners.
Usually they all start within 3–10 s of the run being created; one observed run
staggered starts over 59 s. So a slow allocation shows up as ~1 minute of extra
wall clock with every job still fast.

## Where the remaining time actually goes (and why to stop here)

> **Superseded (2026-09-30)** by [Revisited: a 3-way shard of the admin projects
> only](#revisited-a-3-way-shard-of-the-admin-projects-only-2026-09-30). The
> numbers below are v0.1.70-71 and are kept as the record of that decision.

Every lane of adamdaniel.ai's v0.1.70 bump PR (run 31184726404), split into the
two parts that matter:

| lane | total | install | tests |
|---|---|---|---|
| `webkit-iphone16` | **202 s** | 39 s | **141 s** |
| `chromium-desktop-3k` | 156 s | 25 s | 104 s |
| `webkit-tablet` | 114 s | 51 s | 34 s |
| `chromium-desktop-1080` | 89 s | 25 s | 34 s |
| `firefox-desktop` | 86 s | 34 s | 27 s |
| `chromium-light` | 83 s | 22 s | 38 s |
| `chromium-large-text` | 78 s | 23 s | 33 s |
| `chromium-forced-colors` | 77 s | 23 s | 32 s |
| `chromium-mobile` | 73 s | 23 s | 21 s |
| `chromium-laptop` | 71 s | 21 s | 29 s |

Three things this settles:

1. **The long pole is WebKit's test speed, not the install.** `webkit-iphone16`
   spends 141 s running the SAME `@admin-read` specs that `chromium-desktop-3k`
   gets through in 104 s *while also* running every `@admin-write` round trip.
   Nothing in the CI design can fix that; it is the engine.
2. **WebKit's apt half is ~2x Chromium's** (51 s vs 21-25 s on the same run) —
   worth knowing before blaming a webkit lane's install for being stalled. A
   *stall* looks like 600 s+, not 51 s.
3. **The fixed cost is ~42 s and mostly irreducible**: ~3 s of checkouts, 4 s
   Node, 3 s `npm ci`, 21-25 s `playwright install` (chromium), 5 s Ruby/Bundler,
   ~3 s artifacts + the failure-comment steps. `Resolve this project's browser
   engine` is 0 s.

**Confirmed on a second release, and the gap NARROWED.** The v0.1.71 bump PRs
(adamdaniel.ai run 31214974952, jodidaniel.com run 31214982451) re-measured the
same two lanes independently:

| lane | adamdaniel.ai | jodidaniel.com |
|---|---|---|
| `webkit-iphone16` | **188 s** (32 s install) | **148 s** (62 s install) |
| `chromium-desktop-3k` | 177 s (22 s install) | 110 s (25 s install) |
| wall clock | **204 s** | **162 s** |
| runner-seconds | 1037 s | 897 s |

Both wall clocks land inside the ranges below, and every install came in at
21-62 s — so the bounded/retried composite is holding and no lane was stalled.
The number that matters for the decision below is the **11 s** now separating
adamdaniel's pole from its runner-up (188 vs 177): the re-check trigger at the
end of this section moved FURTHER from firing, not closer.

**The next optimization, priced.** Sharding *within* a project is the only lever
left, and the arithmetic says stop: a 2-way shard of `webkit-iphone16` halves its
141 s of tests but each shard still pays its own ~39-61 s install and ~42 s fixed
cost, landing both around ~120 s. That would make `chromium-desktop-3k` (156 s)
the new long pole, so the whole run improves by **~45 s** — and to get past 156 s
you would have to shard that lane too, i.e. go to a project x shard matrix of
**20 jobs** for maybe 60 s. Against ~200 s that is a ~30% cut for double the job
count, double the fixed cost, a second matrix dimension in every consumer's
required check, and a `--shard` split whose balance is exactly the thing measured
to be unreliable above.

Not worth it *today*, and the number to re-check before revisiting is simple: if
`webkit-iphone16`'s test time ever grows past roughly twice
`chromium-desktop-3k`'s, sharding it alone starts paying for itself without the
second dimension.

## Re-measuring

The per-project job durations are in the run's job list, and the per-test
durations are in each job's `--reporter=list` output:

```bash
# job + step durations for a run
gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | {name, started_at, completed_at, steps: [.steps[] | {name, started_at, completed_at}]}'

# per-test durations for one project job
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs | grep -E '✓|✘'

# apt split inside the install step: fetch size and time, and whether the
# .deb cache hit ("Need to get 0 B/<n> MB") or which entry it restored
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs \
  | grep -E 'Need to get|Fetched|Cache restored from key|restored \.debs|apt \.deb cache key'
```

To try a different worker count without cutting a release, pass the reusable's
`workers` input (it overrides every job): `workers: "2"`. To change the policy
permanently, edit `CI_WORKERS` in `e2e/ci-matrix.js` (locked by the "every
project job runs at the same measured worker count" assertion in
`e2e/ci-matrix.test.js`).

## Operational invariants (moved from AGENTS.md)

AGENTS.md used to carry its own summary of this design under "E2E
parallelism — one CI job per Playwright project"; that summary duplicated
the sections above almost line for line and was cut. Two pieces of guidance
from it are NOT restated anywhere above, so they're kept here verbatim:

- **The 3-engine `install --with-deps` was 58 s of every job's critical path**
  (39 s apt + 19 s download). One engine per job removes most of it, needs no
  cache key, and can't go stale. **If you add a project, give it an explicit
  `use.browserName`** (`engineFor()` throws otherwise) and add it to the workflow
  matrix (the lint will tell you).

The required status context is **unchanged**: the matrix sits behind an
aggregating `e2e` gate job (`needs: project`, `if: always()`, fails on any
non-success matrix result), so rulesets and the `e2e-required-stub` companion
still name exactly `e2e / e2e`. Per-job artifacts and failure-comment markers
are slot-scoped (`playwright-report-<slot>`, `e2e-failure-summary-<slot>`,
where a slot is the project name or `<project>-shard-<i>-of-<n>`) — jobs sharing
either would clobber each other, and a marker that names the project and shard
says which one went red before you open a log.

## node-unit-lints (self-ci)

`self-ci.yml`'s `node-unit-lints` job runs the e2e harness's pure-fs lints
(`*.test.js`, no browser, no build) as one of the platform's seven REQUIRED
`platform-main` contexts. cms-platform#461 measured whether it could be made
faster the same way `e2e-tests.yml` was — more workers, or sharding — after
first adding a cache for the ~10 s browser-download self-heal the job pays on
every run regardless (`e2e/install-browsers-on-miss.js`'s globalSetup checks
for chromium even though this lane never launches a browser; `npm ci` runs
with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so a self-heal miss is guaranteed
without it).

**Baseline, measured on PR #461's own head before any worker/shard change**
(run 36004123542, job 107647791690): a cache MISS measured 57 s of "Run
pure-fs harness lints" (job wall 71 s), `Running 2112 tests using 2 workers`
appearing ~16 s after the step starts (the download). A same-commit rerun
(job 107648819120) measured the cache HIT case the branch would see on every
push after the first: 46 s step / 62 s job wall.

**Four shapes measured, all with the cache in place, 2-3 samples each** (`gh
run view <id> --json jobs` for job/step timestamps; `gh api
.../jobs/<id>/logs | grep -E 'Running .* workers|Cache restored|Cache not
found'` for worker count + cache-hit confirmation):

| variant | change | run id | step samples (s) | job-wall samples (s) | job-wall avg (s) |
|---|---|---|---|---|---|
| V0 | cache only (PR head, cache hit) | 36004123542 (jobs 107648819120, 107649399495) | 46, 49 | 62, 66 | 64.0 |
| V1 | + `PW_WORKERS: '100%'` (4 workers) | 36005064648 (jobs 107650999867, 107651505530, 107653313074) | 33, 44, 45 | 51, 63, 62 | 58.7 |
| V2 | + `PW_WORKERS: '150%'` (6 workers) | 36005428781 (jobs 107652240070, 107652803523, 107653324243) | 49, 36, 49 | 64, 53, 63 | 60.0 |
| V3 | 3-way `--shard` at 100%, behind a `node-unit-lints` gate job | 36006324455 (3 reruns) | max-shard: 28-42 (per sample) | 76, 57, 52 (first-shard-start → gate-complete) | 61.7 |

V1 and V2 are drop-in `PW_WORKERS` changes to the single job; each rerun is a
fresh sample of the same commit. V3 restructures the job: `node-unit-lints-
shard` is a 3-way matrix (`strategy.fail-fast: false`, native `--shard=i/3` —
confirmed locally with `--list --shard=1/3|2/3|3/3` against the DENY-filtered
148-spec, 2112-test set: exactly 704/704/704) at the same 100% worker setting,
and `node-unit-lints` becomes a GATE job (`needs: node-unit-lints-shard`, `if:
always()`, no `timeout-minutes`, no `concurrency` — e2e/required-context-
cancellable.test.js requires this shape of any job publishing a required
context, the same one `site-verify.yml` and `e2e-tests.yml`'s `e2e` job use)
that reads `needs.node-unit-lints-shard.result` and fails unless it is
`success`. V3's "job-wall" column is the required context's real latency:
from the first shard's start to the gate job's completion, since that is what
actually gates a merge.

**Decision: V1 (single job, `PW_WORKERS: '100%'`).** It has the best average
(58.7 s vs V0's 64.0 s, V2's 60.0 s, V3's 61.7 s) and is the simplest of the
three changes — one job, one env var, no matrix, no gate wiring, no extra
runner-minutes. V3 was measured and rejected: splitting ~40 s of test time
three ways is largely eaten by each shard re-paying its own ~15-20 s fixed
cost (checkout, setup-node, `npm ci`, cache restore), and one of three
samples caught GitHub staggering the three runners' allocation by ~36 s,
landing WORSE than doing nothing at all (76 s job-wall vs V0's 64 s average).
The same lesson this file's "Where the remaining time actually goes" section
drew about sharding the browser suite applies here at a smaller scale: fixed
per-job cost and allocation variance eat the gain faster than the math on
paper suggests. 150% (V2), this file's setting for `e2e-tests.yml`'s
mixed pure-fs/browser project jobs, is not obviously better than 100% on
THIS job's shape (2112 short pure-fs tests, no per-test wait time) — a
different worker/job-shape combination needs its own measurement, not a
number carried over from a different lane.

**V3's gate mechanism was still proven correct on real CI before being
discarded**, because no Docker daemon was reachable in the session that did
this work (`act` needs one; see "act learnings" below) — a temporary commit
(cms-platform#461, since reverted) re-applied the V3 shape with
`node-unit-lints-shard (2)` forced to fail on purpose. Run 36007114424
confirmed all three structural properties: shard 2 failed (job
107658017763), shards 1 and 3 still ran to completion and passed (jobs
107658017748, 107658017932 — `fail-fast: false` holding), and the gate job
(107658289737) read the non-success matrix result and reported the required
context `node-unit-lints` as `FAILURE` — not `cancelled`, not stuck on
"Waiting for status to be reported". The very next commit reverted to the
chosen V1 shape.

**Re-measuring:** same commands as the section above, against
`self-ci.yml`'s `node-unit-lints` job id (and `node-unit-lints-shard` if a
sharded variant is tried again). `gh run rerun <run-id> --job <job-id>`
reruns one job in place for an additional same-commit sample; `gh run rerun
<run-id>` (no `--job`) reruns every job, needed to get a fresh V3 sample
because its runner-allocation stagger is a property of the whole matrix
launch, not of one job.

### Less repeated work (2026-10-04)

[Issue #462](https://github.com/Adam-S-Daniel/cms-platform/issues/462) follows
the worker/shard experiment above by reducing repeated child processes and
parsing. The baseline was
[commit 3818240](https://github.com/Adam-S-Daniel/cms-platform/commit/381824060a448677eb78dc7cda5bf2889271d60f).
The five files retain **237 tests**:
[ci-matrix](../e2e/ci-matrix.test.js) 14,
[scaffold agreement](../e2e/examples-site-scaffold-agreement.test.js) 15,
[gitleaks canary](../e2e/gitleaks-allowlist-canary.test.js) 24,
[repo-settings audit](../e2e/repo-settings-audit.test.js) 102, and
[scheduled-run health](../e2e/scheduled-run-health.test.js) 82. Every assertion
and case remains; each real CLI contract retains a real invocation. Measured
gitleaks invocations fall **28 → 17**, fixture `gh` invocations **47 → 10**, and
matrix/config Node invocations **30 → 10**. Immutable parsed inputs are shared
per worker, with copies for mutation cases and independent test failures.

Each comparison below has three clean local runs per side, measured with
`/usr/bin/time -v`; **CPU-seconds = user + system**, including child processes.
Five-file runs used `--project=chromium-light --workers=1 --reporter=line`.
Full-lane runs used the unchanged
[self-CI lint command](../.github/workflows/self-ci.yml), with `TARGET=prod`,
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `PW_PROJECT=chromium-light`, `CI` unset,
and `PW_WORKERS` set to the stated count. All ran in a PID namespace on the
same host with 24 logical CPUs and the same dependencies. The four-worker
comparison matches the CI worker count, but enforces no CPU affinity or quota;
it remains a local measurement on that host.

| Scope / workers / version | CPU samples (s) | CPU median (range), s | Wall samples (s) | Wall median (range), s |
|---|---|---|---|---|
| Five files / 1 / before | 42.12, 50.62, 52.18 | 50.62 (42.12–52.18) | 31.75, 38.55, 40.60 | 38.55 (31.75–40.60) |
| Five files / 1 / after | 21.78, 19.33, 18.43 | 19.33 (18.43–21.78) | 16.77, 14.29, 14.65 | 14.65 (14.29–16.77) |
| Full lane / 24 / before | 362.37, 360.41, 397.98 | 362.37 (360.41–397.98) | 24.28, 22.75, 26.16 | 24.28 (22.75–26.16) |
| Full lane / 24 / after | 421.51, 396.21, 398.70 | 398.70 (396.21–421.51) | 28.40, 25.58, 27.09 | 27.09 (25.58–28.40) |
| Full lane / 4 / before | 201.87, 219.58, 183.01 | 201.87 (183.01–219.58) | 45.57, 48.85, 42.21 | 45.57 (42.21–48.85) |
| Full lane / 4 / after | 171.76, 187.41, 193.63 | 187.41 (171.76–193.63) | 41.24, 43.39, 43.35 | 43.35 (41.24–43.39) |

All clean five-file runs passed 237 tests and exited 0. All clean full-lane
runs exited 0 with **3,655 passed + 98 skipped = 3,753 tests** across 183 files;
the 2,112-test count above is the earlier experiment's snapshot. An initial
baseline canary run hit an existing random probe diagnostic flake: a per-rule
allowlist produced the whole-file-skip message instead of the expected
rule-specific message. Failed baseline samples were retained separately and
excluded from the timing table; their assertions were preserved.

The five-file CPU median drops about **62%**. Whole-lane results depend on
worker count: at four workers, CPU and wall medians fall about **7%** and
**5%**, with overlapping ranges; at 24 workers, both medians regress. These
measurements establish the targeted CPU reduction and a modest local
four-worker improvement, without establishing a faster GitHub job.

Three **before-only CI** `Run pure-fs harness lints` step samples are
[79 s](https://github.com/Adam-S-Daniel/cms-platform/actions/runs/37242331905/job/111553363207),
[56 s](https://github.com/Adam-S-Daniel/cms-platform/actions/runs/37242134166/job/111552804256), and
[53 s](https://github.com/Adam-S-Daniel/cms-platform/actions/runs/37240324345/job/111547578693).
Post-change CI samples remain unavailable because this sprint did not push or
dispatch workflows. The issue's three-run CI before/after requirement remains
open until the proposed change runs there.

### act learnings (from this measurement session)

The task called for validating the shard+gate wiring with `nektos/act`
(`act pull_request -W .github/workflows/self-ci.yml -j <job>`) before
pushing each variant. It could not be used in this session:

- `docker` was not on `PATH`, and `/usr/bin/docker` (present via a symlink)
  resolved to `/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker` — a
  **broken** symlink, because this WSL distro had no active Docker Desktop
  WSL integration mounted at `/mnt/wsl/docker-desktop` at all (not merely "not
  running" — the mount point itself was absent). `act`'s own error surfaced
  this correctly: `failed to connect to the docker API at
  unix:///var/run/docker.sock: ... no such file or directory`.
- No alternative container runtime (`podman`, `nerdctl`, `finch`, `colima`)
  was present either, so there was no fallback inner loop available at all in
  this environment — this is an environment gap, not a workflow-authoring one.
- **Fallback used instead, and it covered the same ground `act` would have
  for THIS change:** (1) `actionlint` plus the repo's own AST-based workflow
  lints (`e2e/required-context-cancellable.test.js`,
  `e2e/engine-scope-lint.test.js`, `e2e/workflow-injection-lint.test.js`) run
  locally against every variant before each push — these parse the YAML
  structurally and would catch a malformed matrix/gate shape, a missing
  `fail-fast: false`, a `timeout-minutes` on the wrong job, or (caught for
  real, see below) an unsafe expression interpolation. (2) `--shard`
  partitioning was verified locally with `--list --shard=i/3` against the
  exact spec list the job builds. (3) The gate's own bash was dry-run locally
  with synthetic `SHARD_RESULT=success|failure|cancelled` inputs before the
  first push, confirming exit 0/1/1. (4) The gate's real behavior — a failed
  shard reddening the required context without ever reporting `cancelled` or
  hanging — was proven on a REAL run (36007114424, see above) with a
  temporary deliberately-failing commit, since that is the one thing neither
  `act` nor a local dry-run can actually confirm (GitHub's own scheduling and
  status-reporting behavior).
- **One correctness bug this fallback loop caught that a pure timing focus
  would have missed:** the first V3 draft interpolated `${{ matrix.shard }}`
  directly into the `run:` script body (`--shard=${{ matrix.shard }}/3` and an
  echo line). `e2e/workflow-injection-lint.test.js` reds on ANY `matrix.*` (or
  `env.*`) expression substituted into a code body — categorically, not by
  dataflow — because that is the same laundering shape an attacker-controlled
  `github.event.*` interpolation would take, and the lint does not special-
  case "but this one is a hardcoded `[1, 2, 3]` list". Fix: bind it to a
  job-level `SHARD` env var and reference `"${SHARD}"` in the script instead.
  Worth carrying forward: any new matrix job in this repo needs its matrix
  values read back through `env:`, never spliced into a `run:`/`with.script`
  body directly, and the repo's own lint suite catches this locally in
  seconds — the same category of check `act` would only catch by actually
  executing the step and observing behavior, not by parsing the YAML shape.
