// @lane: real — seeds, scheduler-flips, and deletes a real, ephemeral prod _posts/ entry via labelled PRs
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — CMS_E2E_PAT and RUN_SCHEDULED_PUBLISH_LOOP aren't wired into
// the standard PR matrix — so selecting + bringing it up just to no-op is
// pure waste. The dedicated cms-scheduled-publish-loop workflow runs it.

/*
 * Real-HTTP, real-GitHub end-to-end test for the SCHEDULED-PUBLISH chain:
 *
 *   scheduled draft on main → publish-scheduled-posts.yml (dispatch) →
 *   cms/posts/scheduled-publish-* PR → cms/ready auto-merge →
 *   deploy-production → URL serves → delete → 404.
 *
 * WHY THIS LOOP EXISTS (the failure it guards against): the scheduler
 * used to flip `published: false → true` and `git push origin main`
 * with the default GITHUB_TOKEN. Consumer repos protect main with a
 * ruleset (pull_request rule + required status checks, NO bypass
 * actors), so that push was rejected the FIRST time a post ever came
 * due — and even if it had landed, a GITHUB_TOKEN push does not trigger
 * deploy-production (the token-suppression anti-recursion policy
 * documented on cms-editorial-workflow.yml's auto-merge-when-ready
 * job). The pre-fix scheduler therefore had ZERO successful publishes,
 * ever, and the breakage was invisible: schedule-event failures have no
 * PR to go red on. The reworked scheduler rides the platform's own
 * PR + auto-merge path (publish-scheduled-posts.yml); this loop is the
 * live proof that the whole chain — including the "not before the
 * deadline" half — actually works against prod.
 *
 * API + HTTP only: no browser page is used (the scheduler, not Decap,
 * is the machinery under test), but the spec keeps the standard ./base
 * scaffolding so TARGET=prod baseURL resolution and the shared helpers
 * work exactly as in the sibling loops.
 *
 * Flow:
 *   1. Seed `_posts/2099-12-31-e2e-scheduled-publish-<runId>.md` via
 *      seedFixtureViaPr — front matter mirrors the prod-mutate canary
 *      (robots noindex,nofollow; sitemap false; test_fixture true) but
 *      `published: false` and `publish_date` = seed time +
 *      DEADLINE_WINDOW_MS. Unadvertised: noindex + no sitemap + never
 *      linked; the slug carries the runId so the path is per-run-unique.
 *   2. "Not before": assert /blog/<slug>/ 404s, dispatch the consumer's
 *      publish-scheduled-posts.yml, wait for that run to complete,
 *      assert it concluded success WITHOUT creating a
 *      cms/posts/scheduled-publish-* PR (the changed=false path), and
 *      that the URL still 404s.
 *   3. Wait out the remaining seconds of the deadline window.
 *   4. "At/after": dispatch again; the run must open the auto-publish
 *      PR; wait for auto-merge to land it, then for prod to serve the
 *      run marker (deploy-production fires off the PAT-user merge).
 *   5. Delete leg: removeFixtureViaPr, assert the URL 404s again.
 *   afterAll: existence-only removal PR (fire-and-forget) if the test
 *   died mid-flow. Resting state is ABSENCE (404) — absence has no
 *   corrupt variant (#1771 step 4). A killed run leaks at most ONE
 *   inert, noindexed, uniquely-named orphan, swept by
 *   sweep-stale-cms-prs.yml — never a shared mutable baseline.
 *
 * THE DEADLINE WINDOW (why it is NOT a small constant like 4 minutes):
 * `publish_date` is written into the seed PR's front matter BEFORE the
 * seed auto-merges, and seedFixtureViaPr legitimately takes up to its
 * 25-min merge budget under required-check contention. The "not before"
 * leg can only run after the seed lands, so the window must span the
 * worst-case seed merge PLUS the leg-2 scheduler run PLUS a safety
 * margin — otherwise leg 2 races the deadline and the changed=false
 * assertion flakes. Hence DEADLINE_WINDOW_MS = SEED_MERGE_TIMEOUT_MS +
 * SCHEDULER_RUN_TIMEOUT_MS + DEADLINE_MARGIN_MS (40 min): long enough
 * that leg 2 PROVABLY runs pre-deadline (each budget throws before the
 * window can be overrun), short enough that the whole loop still fits
 * the job budget.
 *
 * Gating:
 *   - `CMS_E2E_PAT` must be set (Contents/PR/Actions on the host repo).
 *   - `RUN_SCHEDULED_PUBLISH_LOOP=1` (set only in
 *     cms-scheduled-publish-loop.yml).
 *
 * IMPORTANT: do NOT run this spec locally against prod. It mutates the
 * real production tree. The dedicated workflow runs it on a schedule.
 */
const path = require("node:path");
const { guard } = require("./base-collections-guards");
// #33/#21 — resolved like the other registered specs so the drift lint matches it.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");
const { test, expect } = require("./base");
const { getPat, HOST_REPO } = require("./decap-pat");
const { seedFixtureViaPr, removeFixtureViaPr } = require("./cms-fixture-pr");
const { gh, waitForMerge, fetchPublicUrl } = require("./github-actions-poll");
const { prodTarget } = require("./cms-host");
const { loudBail } = require("./fixture-baseline");
const { EPHEMERAL_DATE } = require("./prod-mutate-fixture");

const { host: PROD_HOST } = prodTarget();

// The consumer's thin caller (same filename as the platform reusable it
// delegates to) — the workflow_dispatch target for both scheduler legs.
const SCHEDULER_WORKFLOW = "publish-scheduled-posts.yml";
// The reusable's per-run PR branch prefix. `cms/` first segment keeps it
// Decap-shaped (label-non-decap-prs + the content-PR guards); locked by
// e2e/publish-scheduled-posts-flow.test.js.
const SCHEDULED_PUBLISH_BRANCH_PREFIX = "cms/posts/scheduled-publish-";
const SLUG_PREFIX = "e2e-scheduled-publish";

// ── Budgets ───────────────────────────────────────────────────────────
// Seed / remove PR merges ride the same labelled-PR auto-merge path as
// every fixture PR — 25 min each, matching seedFixtureViaPr's documented
// rationale (required-check matrix under busy runners).
const SEED_MERGE_TIMEOUT_MS = 25 * 60 * 1000;
const REMOVE_MERGE_TIMEOUT_MS = 25 * 60 * 1000;
// One publish-scheduled-posts run is two checkouts + a python scan + (at
// most) a branch push and a PR create — a couple of minutes of work; 10
// min absorbs runner queue depth.
const SCHEDULER_RUN_TIMEOUT_MS = 10 * 60 * 1000;
// Safety margin on the deadline derivation so a jittery run poll can
// never straddle the boundary.
const DEADLINE_MARGIN_MS = 5 * 60 * 1000;
// See "THE DEADLINE WINDOW" in the header — spans worst-case seed merge
// + the pre-deadline scheduler leg + margin (40 min).
const DEADLINE_WINDOW_MS = SEED_MERGE_TIMEOUT_MS + SCHEDULER_RUN_TIMEOUT_MS + DEADLINE_MARGIN_MS;
// Wait this far PAST the deadline before the at/after dispatch so
// runner-vs-harness clock skew can't make the scheduler still read the
// post as "due in ~0h".
const POST_DEADLINE_SKEW_MS = 60 * 1000;
// The at/after run opens its PR synchronously before completing, so the
// PR should be visible the moment the run concludes; 5 min absorbs API
// list lag.
const PR_APPEAR_TIMEOUT_MS = 5 * 60 * 1000;
// The auto-publish PR merges via auto-merge-when-ready — same 25-min
// budget class as the fixture PRs (same required-check matrix).
const PUBLISH_MERGE_TIMEOUT_MS = 25 * 60 * 1000;
// URL reflect AFTER the merge is already confirmed (unlike the
// prod-mutate reflect legs, which start pre-merge and need the 30-min
// auto-merge floor, #1815): this only spans deploy-production + CDN.
const REFLECT_TIMEOUT_MS = 20 * 60 * 1000;
// Worst-case sum: 25 (seed) + 10 (leg 2) + 40-window remainder + 10
// (leg 4 run) + 5 (PR appear) + 25 (publish merge) + 20 (reflect) + 25
// (remove merge) + 20 (404 reflect) ≈ 146 min → 150. Fits the 165-min
// job timeout in cms-scheduled-publish-loop.yml (alignment locked by
// e2e/publish-scheduled-posts-flow.test.js). Retries disabled — this
// mutates real prod; a retry re-runs the same broken chain.
const TEST_TIMEOUT_MS = 150 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Module-scoped handle so the afterAll safety-net can see what the test
// generated. The forward DELETE leg IS the cleanup; the safety net only
// acts when the test died mid-flow.
let pendingFixture = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// `publish_date` in the format publish_scheduled_posts.py parses first
// ("%Y-%m-%d %H:%M:%S %z"), always UTC.
function formatPublishDate(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

// Per-run scheduled-draft builder. Front matter mirrors the prod-mutate
// canary (prod-mutate-fixture.js composePost) except `published: false`
// + a real near-future `publish_date` — the two fields the scheduler
// keys on. Future-dated 2099-12-31 so the post, once flipped, serves the
// same way the sibling canaries do (`_config.yml` `future: true`).
function buildScheduledPublishPost({ runId, publishDateMs }) {
  const slug = `${SLUG_PREFIX}-${runId}`;
  const filePath = `_posts/${EPHEMERAL_DATE}-${slug}.md`;
  const publicPath = `/blog/${slug}/`;
  const title = `E2E Scheduled Publish ${runId}`;
  const marker = `${SLUG_PREFIX}:${runId}`;
  const body =
    `Ephemeral E2E scheduled-publish canary (run ${runId}; do not edit by hand).\n\n` +
    `This post is SEEDED with published: false, flipped live by the ` +
    `publish-scheduled-posts workflow's PR + auto-merge flow, asserted served, ` +
    `then DELETED within a single run of e2e/cms-scheduled-publish-loop.spec.js. ` +
    `Its resting state is absence (404). The run marker is ${marker}.\n`;
  const fileText = [
    "---",
    `title: ${title}`,
    `slug: ${slug}`,
    `date: ${EPHEMERAL_DATE} 00:00:00 +0000`,
    "tags: []",
    'featured_image: ""',
    "published: false",
    "robots: noindex,nofollow",
    "sitemap: false",
    `publish_date: ${formatPublishDate(publishDateMs)}`,
    "test_fixture: true",
    "---",
    "",
    body,
  ].join("\n");
  return { runId, slug, filePath, publicPath, title, marker, fileText };
}

async function fileExistsOnMain(filePath) {
  try {
    await gh(`/repos/${HOST_REPO}/contents/${filePath}?ref=main`);
    return true;
  } catch (e) {
    if (/\b404\b/.test(String(e.message))) return false;
    throw e;
  }
}

// Every OPEN PR whose head branch is a scheduled-publish branch.
async function openScheduledPublishPrs() {
  const prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=100`);
  return (prs || []).filter(
    (pr) =>
      pr.head &&
      typeof pr.head.ref === "string" &&
      pr.head.ref.startsWith(SCHEDULED_PUBLISH_BRANCH_PREFIX),
  );
}

// Dispatch the consumer's publish-scheduled-posts.yml and wait for THAT
// run (not a stale one) to complete. New-run identity is by run id
// ordering — capture the newest existing id BEFORE dispatching and wait
// for a workflow_dispatch run with a greater id — so harness-vs-GitHub
// clock skew can't misattribute a run.
async function dispatchSchedulerAndAwait(label) {
  const wfBase = `/repos/${HOST_REPO}/actions/workflows/${SCHEDULER_WORKFLOW}`;
  const runsUrl = `${wfBase}/runs`;
  const before = await gh(`${runsUrl}?per_page=1`);
  const maxSeenId = ((before.workflow_runs || [])[0] || {}).id || 0;

  // POST .../dispatches answers 204 No Content; gh() unconditionally
  // res.json()s, which rejects on the empty body — treat that specific
  // SyntaxError as the success it is (GitHub accepted the dispatch).
  await gh(`${wfBase}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
    retries: 2,
  }).catch((err) => {
    if (err instanceof SyntaxError) return null;
    throw err;
  });

  const deadline = Date.now() + SCHEDULER_RUN_TIMEOUT_MS;
  let run = null;
  while (Date.now() < deadline && !run) {
    const data = await gh(`${runsUrl}?event=workflow_dispatch&per_page=10`);
    run = (data.workflow_runs || []).find((r) => r.id > maxSeenId) || null;
    if (!run) await sleep(6000);
  }
  expect(
    run,
    `[${label}] no new ${SCHEDULER_WORKFLOW} workflow_dispatch run appeared within ` +
      `${SCHEDULER_RUN_TIMEOUT_MS / 60000} min of dispatching (last seen run id ${maxSeenId})`,
  ).toBeTruthy();

  while (Date.now() < deadline && run.status !== "completed") {
    await sleep(10_000);
    run = await gh(`/repos/${HOST_REPO}/actions/runs/${run.id}`);
  }
  expect(
    run.status,
    `[${label}] ${SCHEDULER_WORKFLOW} run ${run.id} did not complete within ` +
      `${SCHEDULER_RUN_TIMEOUT_MS / 60000} min (status ${run.status})`,
  ).toBe("completed");
  expect(
    run.conclusion,
    `[${label}] ${SCHEDULER_WORKFLOW} run ${run.id} concluded ${run.conclusion} — expected ` +
      `success (${run.html_url})`,
  ).toBe("success");
  return run;
}

// Poll until the URL stops serving (4xx). The inverse of fetchPublicUrl.
async function waitForUrlGone(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      lastStatus = res.status;
      if (res.status >= 400 && res.status < 500) return;
    } catch (err) {
      console.warn(`[waitForUrlGone] transient fetch error on ${url}: ${err && err.message}`);
    }
    await sleep(6000);
  }
  throw new Error(
    `Timed out waiting for ${url} to 404 after the delete merged (last status ${lastStatus}).`,
  );
}

test("scheduled-publish loop — draft seeds, scheduler flips it live via PR + auto-merge, delete restores absence", async () => {
  // Only the dedicated cms-scheduled-publish-loop.yml workflow opts in.
  // Plain green skip FIRST so a PR-matrix run exits before the loud
  // guards below (mirrors the prod-mutate gate).
  test.skip(
    process.env.RUN_SCHEDULED_PUBLISH_LOOP !== "1",
    "RUN_SCHEDULED_PUBLISH_LOOP not set — only the cms-scheduled-publish-loop workflow runs this spec.",
  );
  // #33/#21 — a base_collections:[] bio ships no posts collection / /blog/ surface; skip green there.
  test.skip(...guard(SITE_ROOT, "cms-scheduled-publish-loop.spec.js"));

  // Past the gates the spec is SUPPOSED to run — an unmet precondition
  // is a loud red on a schedule/dispatch run (#1053).
  if (!getPat()) {
    loudBail(test, "CMS_E2E_PAT not set — scheduled-publish loop cannot run.");
    return;
  }

  const runId = Date.now();
  const publishDateMs = Date.now() + DEADLINE_WINDOW_MS;
  const built = buildScheduledPublishPost({ runId, publishDateMs });
  const { slug, filePath, marker, fileText } = built;
  const publicUrl = `${PROD_HOST}${built.publicPath}`;
  pendingFixture = { runId, slug, filePath };
  test.info().annotations.push({ type: "fixture-path", description: filePath });

  // ── 0. Preflight: no scheduled-publish PR may already be in flight ──
  // The reusable's stacking guard suppresses PR creation while one is
  // open, so a lingering PR would make BOTH scheduler legs no-op and the
  // failure would only surface 40+ minutes in. Fail fast + actionable.
  await test.step("Preflight — no open scheduled-publish PR (the stacking guard would suppress this run)", async () => {
    const open = await openScheduledPublishPrs();
    expect(
      open.map((pr) => `#${pr.number} (${pr.head.ref})`),
      `an open ${SCHEDULED_PUBLISH_BRANCH_PREFIX}* PR is already in flight — the ` +
        `scheduler's stacking guard will refuse to open another, so this loop cannot ` +
        `validate anything. Let it auto-merge (it carries cms/ready) or close it, then re-run.`,
    ).toEqual([]);
  });

  // ── 1. Unique per-run path starts absent ─────────────────────────────
  await test.step("Confirm /blog/<slug>/ 404s before seeding (unique per-run path)", async () => {
    const res = await fetch(publicUrl, { cache: "no-store" });
    expect(
      res.status,
      `${publicUrl} must not exist yet (unique per-run name) — got ${res.status}`,
    ).toBe(404);
  });

  // ── 2. Seed the scheduled draft on main via a labelled fixture PR ────
  await test.step("Seed the published:false draft with publish_date = T+40min (seedFixtureViaPr)", async () => {
    await seedFixtureViaPr({
      slug,
      runId,
      filePath,
      bodyText: fileText,
      message: `test(scheduled-publish): seed ${filePath} for run ${runId}`,
      prTitle: `test(scheduled-publish): seed ${filePath} for run ${runId}`,
      prBody:
        "Automated fixture seed for `e2e/cms-scheduled-publish-loop.spec.js` " +
        `(run \`${runId}\`): a \`published: false\` post whose \`publish_date\` the ` +
        "scheduled-publish workflow will flip live via its PR + auto-merge flow. " +
        "Auto-merges via the `cms/ready` label; the loop deletes the post at the end.",
      timeoutMs: SEED_MERGE_TIMEOUT_MS,
    });
  });

  // ── 3. "Not before" — the pre-deadline run must be a no-op ──────────
  await test.step("Not-before — URL still 404s (published:false never renders)", async () => {
    const res = await fetch(publicUrl, { cache: "no-store" });
    expect(
      res.status,
      `${publicUrl} must still 404 after the seed merged — the draft is published:false`,
    ).toBe(404);
  });

  let prsBeforeDeadline = [];
  await test.step("Not-before — dispatch the scheduler; run succeeds WITHOUT creating a PR", async () => {
    // Provably pre-deadline: the whole leg-2 run budget must fit before
    // publish_date. The window derivation guarantees this whenever the
    // earlier budgets held (see the header); assert it so a budget edit
    // that breaks the derivation fails HERE, not as a flaky changed=true.
    expect(
      Date.now() + SCHEDULER_RUN_TIMEOUT_MS,
      "leg 2 no longer provably runs pre-deadline — DEADLINE_WINDOW_MS must cover " +
        "the seed merge budget + the scheduler run budget + margin (see the header)",
    ).toBeLessThan(publishDateMs);

    prsBeforeDeadline = await openScheduledPublishPrs();
    await dispatchSchedulerAndAwait("not-before");

    const after = await openScheduledPublishPrs();
    const beforeNums = new Set(prsBeforeDeadline.map((pr) => pr.number));
    const created = after.filter((pr) => !beforeNums.has(pr.number));
    expect(
      created.map((pr) => `#${pr.number} (${pr.head.ref})`),
      "the pre-deadline scheduler run must take the changed=false path and create NO " +
        "scheduled-publish PR — publish_date has not arrived yet",
    ).toEqual([]);

    const res = await fetch(publicUrl, { cache: "no-store" });
    expect(
      res.status,
      `${publicUrl} must still 404 after the pre-deadline scheduler run`,
    ).toBe(404);
  });

  // ── 4. Wait out the deadline ─────────────────────────────────────────
  await test.step("Wait out the remaining seconds of the deadline window", async () => {
    // A wall-clock wait is inherent to testing a wall-clock scheduler:
    // publish_date was fixed in the seed's front matter, so the spec
    // must genuinely cross it. Bounded by the window (≤40 min; typically
    // far less — the seed + leg 2 already consumed most of it).
    const remaining = publishDateMs + POST_DEADLINE_SKEW_MS - Date.now();
    if (remaining > 0) {
      console.log(
        `[scheduled-publish] waiting ${Math.ceil(remaining / 1000)}s for publish_date to arrive`,
      );
      await sleep(remaining);
    }
  });

  // ── 5. "At/after" — the run must open the auto-publish PR ───────────
  let publishPr = null;
  await test.step("At/after — dispatch the scheduler; expect the cms/posts/scheduled-publish-* PR", async () => {
    await dispatchSchedulerAndAwait("at-after");

    // The run opens the PR synchronously before completing; poll only to
    // absorb list-API lag. Identify OUR PR by the diff actually flipping
    // this run's fixture file — robust even if a concurrent scheduler
    // run (e.g. the consumer's own daily cron) created the PR first.
    const deadline = Date.now() + PR_APPEAR_TIMEOUT_MS;
    while (Date.now() < deadline && !publishPr) {
      for (const pr of await openScheduledPublishPrs()) {
        let files = [];
        try {
          files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
        } catch (err) {
          console.warn(
            `[scheduled-publish] transient files read on PR #${pr.number}: ${err && err.message}`,
          );
          continue;
        }
        if (files.some((f) => f.filename === filePath && f.status === "modified")) {
          publishPr = pr;
          break;
        }
      }
      if (!publishPr) await sleep(6000);
    }
    expect(
      publishPr,
      `no open ${SCHEDULED_PUBLISH_BRANCH_PREFIX}* PR flipping ${filePath} appeared within ` +
        `${PR_APPEAR_TIMEOUT_MS / 60000} min of the post-deadline scheduler run — the ` +
        "changed=true → PR path regressed",
    ).toBeTruthy();
  });

  // ── 6. Auto-merge lands the flip; prod serves the marker ────────────
  await test.step("Wait for the auto-publish PR to merge (auto-merge-when-ready)", async () => {
    await waitForMerge({ prNumber: publishPr.number, timeoutMs: PUBLISH_MERGE_TIMEOUT_MS });
  });

  await test.step("Wait for /blog/<slug>/ to serve 200 + run marker (deploy-production reflects)", async () => {
    // Merge already confirmed above, so this wait spans only
    // deploy-production + CDN — the merge, made as the PAT user, is what
    // fires the deploy (the GITHUB_TOKEN trap this loop exists to catch).
    await fetchPublicUrl(publicUrl, {
      timeoutMs: REFLECT_TIMEOUT_MS,
      expectContent: marker,
    });
  });

  // ── 7. Delete leg — resting state is absence ────────────────────────
  await test.step("Delete the published post via a labelled removal PR (removeFixtureViaPr)", async () => {
    await removeFixtureViaPr({
      slug,
      runId,
      filePath,
      message: `test(scheduled-publish): remove ${filePath} after run ${runId}`,
      prTitle: `test(scheduled-publish): remove ${filePath} after run ${runId}`,
      prBody:
        "Forward delete leg of `e2e/cms-scheduled-publish-loop.spec.js` " +
        `(run \`${runId}\`) — the loop's resting state is absence (404). ` +
        "Auto-merges via the `cms/ready` label.",
      timeoutMs: REMOVE_MERGE_TIMEOUT_MS,
    });
  });

  await test.step("Confirm /blog/<slug>/ 404s again (resting state restored)", async () => {
    await waitForUrlGone(publicUrl, REFLECT_TIMEOUT_MS);
  });
});

// ── Test-harness cleanup safety net — existence-only DELETE ───────────
// The forward delete leg IS the cleanup; if the test body completed the
// post is gone from main and this no-ops. If the test threw mid-flow,
// the uniquely-named draft (or flipped post) may still be on main —
// open a fire-and-forget removal PR so the next run starts clean. A
// failure here leaks ONE inert, noindexed, uniquely-named orphan that
// sweep-stale-cms-prs.yml reaps — never a shared corrupt baseline
// (#1771 step 4). Mirrors the prod-mutate safety net.
test.afterAll(async () => {
  if (!getPat()) return;
  if (process.env.RUN_SCHEDULED_PUBLISH_LOOP !== "1") return;
  if (!pendingFixture) return; // test never ran (skipped)

  // 2 min — enough for the contents read + PR open under contention,
  // never blocking on the 25-min waitForMerge (skipWaitForMerge below).
  test.setTimeout(2 * 60 * 1000);

  const { filePath, slug, runId } = pendingFixture;
  const stillThere = await fileExistsOnMain(filePath).catch(() => false);
  if (!stillThere) {
    console.log(
      `[cleanup-harness] ${filePath} gone from main; forward delete leg succeeded — no safety net needed`,
    );
    return;
  }
  console.warn(
    `[cleanup-harness] ${filePath} still on main after the test; opening removal PR (existence-only delete, #1771 step 4)`,
  );
  try {
    await removeFixtureViaPr({
      slug,
      runId,
      filePath,
      message: `test(scheduled-publish): cleanup leftover scheduled post run ${runId}`,
      prTitle: `test(scheduled-publish): cleanup leftover scheduled post run ${runId}`,
      prBody:
        "Existence-only cleanup PR opened by `e2e/cms-scheduled-publish-loop.spec.js` after a " +
        "test failure left the throw-away scheduled post on main. Auto-merges via `cms/ready` " +
        "(#1771 step 4 — resting state is absence/404).",
      // Fire-and-forget: the editorial workflow auto-merges it in the
      // background; the daily sweep reaps any orphan.
      skipWaitForMerge: true,
    });
    console.warn(`[cleanup-harness] removed ${filePath} via removal PR`);
  } catch (e) {
    console.warn(`[cleanup-harness] could not remove ${filePath}: ${e && e.message}`);
  }
});
