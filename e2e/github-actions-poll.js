/*
 * Helpers that wait on real GitHub PR / Actions state for the publish-loop
 * end-to-end test. They poll the GitHub REST API directly (not via the
 * `gh` CLI) so a host without `gh` can still run the spec.
 *
 * Auth: re-uses CMS_E2E_PAT — the same fine-grained token Decap is using
 * for the publish dance — which already has `pull-requests: r/w` and
 * `contents: r/w` permissions on the host repo.
 *
 * Each poll function:
 *   - returns the resolved object on success
 *   - throws with a clear `Timed out waiting for …` message on timeout
 *   - sleeps with simple polynomial backoff so the API isn't hammered
 */
const { HOST_REPO, getPat } = require("./decap-pat");
const { augmentTimeoutError } = require("./with-stuck-pr-diagnostic");

const API_ROOT = "https://api.github.com";

function authHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${getPat()}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "adamdaniel-ai-e2e-publish-loop",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Is this a TRANSIENT failure worth retrying? (#1771 step 1 / Plan A
// Lever 1.) GitHub returns these for server-side blips and rate
// limiting; the request itself is well-formed, so a bounded retry can
// recover. Everything else (404 missing, 401 auth, 409 optimistic-
// concurrency conflict, other 4xx) is a real, caller-meaningful error
// that MUST surface immediately — the 409 retry stays in the writer's
// own re-fetch-SHA loop, not here.
function isTransientStatus(status, body) {
  if (status >= 500) return true;
  if (status === 429) return true;
  // A 403 is normally permission-denied (do not retry), EXCEPT GitHub's
  // secondary-rate-limit / abuse-detection responses, which are 403 with
  // a distinctive body and ARE transient.
  if (status === 403 && /secondary rate limit|abuse/i.test(body || "")) return true;
  return false;
}

// Parse a `Retry-After` header (RFC 7231: either delta-seconds or an
// HTTP-date) into a millisecond delay, or null when absent/unparseable.
function parseRetryAfterMs(headerValue) {
  if (headerValue == null) return null;
  const raw = String(headerValue).trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Exponential backoff with full jitter, capped per-attempt. For
// retries:5 the per-attempt caps are 1,2,4,8,16s → ~31s worst-case
// total of pure backoff (before jitter pulls each sample down), which
// matches the budget the issue calls out.
const RETRY_BASE_MS = 1000;
const RETRY_MAX_PER_ATTEMPT_MS = 16_000;
function backoffDelayMs(attempt) {
  const ceiling = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_PER_ATTEMPT_MS);
  // Full jitter: a uniform sample in [0, ceiling] de-synchronises
  // concurrent retriers so they don't re-collide on the same tick.
  return Math.round(Math.random() * ceiling);
}

async function gh(pathname, init = {}) {
  const url = pathname.startsWith("http") ? pathname : `${API_ROOT}${pathname}`;
  // Pull our own options out of `init` BEFORE spreading the rest into
  // fetch — `retries` and `_sleep` are not valid fetch options and must
  // not leak through.
  const { retries = 0, _sleep = sleep, ...fetchInit } = init;
  const maxRetries = Number.isInteger(retries) && retries > 0 ? retries : 0;

  let attempt = 0;
  // The loop runs at most maxRetries+1 times. With the default
  // retries:0 it executes exactly once and is byte-for-byte equivalent
  // to the pre-#1771 single-fetch behaviour: no sleep, no extra reads.
  for (;;) {
    const res = await fetch(url, {
      ...fetchInit,
      headers: { ...authHeaders(), ...(fetchInit.headers || {}) },
    });
    if (res.ok) return res.json();

    const body = await res.text();
    // Attach the HTTP status as a numeric `status` property so
    // callers can branch on it without parsing the message string
    // (e.g. retry on 409 conflicts in optimistic-concurrency PUTs).
    // Message kept verbatim for log compatibility.
    const err = new Error(
      `GitHub API ${res.status} ${res.statusText} on ${url}: ${body.slice(0, 300)}`,
    );
    err.status = res.status;
    err.responseBody = body;

    const retryable = attempt < maxRetries && isTransientStatus(res.status, body);
    if (!retryable) throw err;

    // Honour Retry-After when the server sent one (rate limits do);
    // otherwise fall back to jittered exponential backoff. Cap the
    // honoured value to the per-attempt ceiling so a pathological header
    // can't park us indefinitely.
    const retryAfterMs = parseRetryAfterMs(res.headers && res.headers.get("retry-after"));
    const delayMs =
      retryAfterMs != null
        ? Math.min(retryAfterMs, RETRY_MAX_PER_ATTEMPT_MS)
        : backoffDelayMs(attempt);
    attempt += 1;
    console.warn(
      `[gh] transient ${res.status} on ${url}; retry ${attempt}/${maxRetries} after ${delayMs}ms`,
    );
    await _sleep(delayMs);
  }
}

/**
 * Poll until a PR is opened (or updated) by Decap on the configured branch.
 *
 * Decap's editorial_workflow always sets the same fixed PR body
 * ("Automatically generated by Decap CMS") and a title derived from the
 * collection + slug — neither carries our run-unique marker. So matching
 * has to look at the *diff*: ask the pulls/{N}/files endpoint for the
 * patch on `filePath` and confirm it contains `canaryMarker`. This is
 * also how we tell a stale orphan PR apart from one Decap just refreshed
 * for THIS run (Decap reuses the same `cms/<collection>/<slug>` branch
 * across runs, force-pushing on each save).
 */
async function waitForCmsPullRequest({
  repo = HOST_REPO,
  base,
  headBranchPrefix = "cms/",
  // The path of the file the test expects Decap to commit changes to,
  // relative to the repo root (e.g. "_posts/2099-12-31-e2e-prod-mutate-<runId>.md").
  // Required: without it we can't tell the right cms/ PR from any other.
  filePath,
  // A unique-per-run string the test embedded in the file content. The
  // PR's diff for `filePath` MUST contain this marker — guards against
  // matching a stale PR Decap hasn't refreshed with this run's commit yet.
  canaryMarker,
  timeoutMs = 180_000,
  pollMs = 4_000,
  // Auto-label the matched PR `automated-test` so
  // sweep-stale-cms-prs.yml can safely close it if the test that
  // opened it crashes before auto-merge fires. The label is the
  // signal "definitely automation-opened, sweeping is safe
  // regardless of branch prefix" — without it the sweep has to be
  // conservative about cms/posts/*, cms/tags/*, etc. where real
  // editor drafts can live (run #25473398494 / PR #305 was exactly
  // this case: prod-mutate spec opened a cms/posts/2099-… PR,
  // auto-merge couldn't fire because of unrelated check failures,
  // PR sat 30+ min). Failure to label is non-fatal — the spec's
  // primary contract is finding the PR, not labelling it.
  autoLabelTest = true,
} = {}) {
  if (!canaryMarker) {
    throw new Error("waitForCmsPullRequest needs a canaryMarker to disambiguate the PR.");
  }
  if (!filePath) {
    throw new Error("waitForCmsPullRequest needs a filePath to identify the right cms/... PR.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prs = await gh(
      `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=50`,
    );
    const candidates = prs.filter(
      (pr) =>
        pr.head && typeof pr.head.ref === "string" && pr.head.ref.startsWith(headBranchPrefix),
    );
    for (const pr of candidates) {
      const files = await gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`);
      const hit = files.find(
        (f) =>
          f.filename === filePath && typeof f.patch === "string" && f.patch.includes(canaryMarker),
      );
      if (hit) {
        if (autoLabelTest) {
          try {
            await addLabel({
              repo,
              prNumber: pr.number,
              label: "automated-test",
            });
          } catch (e) {
            console.warn(
              `[waitForCmsPullRequest] could not label PR #${pr.number} automated-test: ${e && e.message}`,
            );
          }
        }
        return pr;
      }
    }
    await sleep(pollMs);
  }
  throw await augmentTimeoutError(
    new Error(
      `Timed out waiting for Decap to open a ${headBranchPrefix}* PR with a ${filePath} change containing marker ${canaryMarker}`,
    ),
    {
      waitingFor: `Decap to open ${headBranchPrefix}* PR (marker ${canaryMarker} on ${filePath})`,
      kind: "pr-open",
    },
  );
}

async function addLabel({
  repo = HOST_REPO,
  prNumber,
  label,
  // Verify-and-retry (run 28761772021 / PR #2469 investigation): every
  // label writer in this repo — this POST, the shim in
  // theme/admin/publish-via-auto-merge.js, cms-editorial-workflow.yml's
  // "Apply draft label" step — is additive, and a repo-wide grep finds
  // zero unlabel/setLabels/replace calls, so a genuine clobber of
  // `cms/ready` has never been observed. What #2469's investigation DID
  // turn up was a diagnostic (scripts/diagnose-stuck-pr.js) that claimed
  // the label was missing without ever checking (fixed alongside this).
  // Close the loop here too: don't just trust the POST's 2xx — re-read
  // the issue and confirm `label` actually stuck before returning, so a
  // genuine application failure (a future racing writer, or a GitHub read
  // replica that's slow to catch up) surfaces here immediately with a
  // clear error, instead of silently, 25 minutes later, as a mystifying
  // waitForMerge timeout.
  verifyRetries = 3,
  verifyDelayMs = 2_000,
  _gh = gh,
} = {}) {
  // Mutating POST — opt into the bounded transient-retry (#1771 step 1).
  // The read-pollers keep the default retries:0 because they already
  // loop on their own deadlines.
  const post = () =>
    _gh(`/repos/${repo}/issues/${prNumber}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [label] }),
      retries: 5,
    });

  const result = await post();
  for (let attempt = 1; attempt <= verifyRetries; attempt++) {
    const issue = await _gh(`/repos/${repo}/issues/${prNumber}`);
    const names = Array.isArray(issue.labels) ? issue.labels.map((l) => (l && l.name) || l) : [];
    if (names.includes(label)) return result;
    if (attempt === verifyRetries) break;
    console.warn(
      `[addLabel] "${label}" not yet visible on #${prNumber} after POST ` +
        `(attempt ${attempt}/${verifyRetries}); re-POSTing and retrying.`,
    );
    await sleep(verifyDelayMs);
    await post();
  }
  throw new Error(
    `addLabel: POST for "${label}" on #${prNumber} returned success ${verifyRetries} ` +
      `time(s) but the label never became visible on a re-read afterward — a genuine ` +
      `application failure, not a read-after-write lag.`,
  );
}

async function getPullRequest({ repo = HOST_REPO, prNumber }) {
  return gh(`/repos/${repo}/pulls/${prNumber}`);
}

async function waitForMerge({
  repo = HOST_REPO,
  prNumber,
  // 5 minutes — happy-path auto-merges fire in <1 min once required
  // checks settle. The previous 8 min default was set for a CI shape
  // that no longer exists; when something IS broken (e.g. the shim's
  // dispatch path), a faster failure surface beats a longer wait that
  // still ends in the same error. Callers that need more headroom
  // (cms-fixture-pr.js helpers, which go through the full editorial-
  // workflow chain) pass their own value.
  timeoutMs = 300_000,
  pollMs = 8_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await getPullRequest({ repo, prNumber });
    if (pr.merged) return pr;
    if (pr.state === "closed" && !pr.merged) {
      throw new Error(`PR #${prNumber} was closed without merging.`);
    }
    await sleep(pollMs);
  }
  throw await augmentTimeoutError(new Error(`Timed out waiting for PR #${prNumber} to merge.`), {
    waitingFor: `PR #${prNumber} to merge`,
    kind: "merge",
    waitPrNumber: prNumber,
  });
}

async function waitForAutoMergeEnabled({
  repo = HOST_REPO,
  prNumber,
  // The cms-editorial-workflow.yml `auto-merge-when-ready` job runs in
  // response to the `labeled` event we fire via addLabel. Cold-start
  // (runner allocation + checkout + npm install for the
  // `enablePullRequestAutoMerge` step) regularly exceeds 90s, so give
  // it 3 minutes before declaring the label-driven path broken.
  timeoutMs = 180_000,
  pollMs = 4_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await getPullRequest({ repo, prNumber });
    if (pr.auto_merge && pr.auto_merge.enabled_by) return pr;
    await sleep(pollMs);
  }
  throw await augmentTimeoutError(
    new Error(`Timed out waiting for auto-merge to be enabled on PR #${prNumber}.`),
    {
      waitingFor: `auto-merge to be enabled on PR #${prNumber}`,
      kind: "auto-merge-enabled",
      waitPrNumber: prNumber,
    },
  );
}

async function waitForWorkflowRun({
  repo = HOST_REPO,
  workflow,
  headSha,
  branch,
  timeoutMs = 600_000,
  pollMs = 12_000,
  expectedConclusion = "success",
} = {}) {
  // `cms-editorial-workflow.yml` has `cancel-in-progress: true` keyed
  // on PR number, so any push to a `cms/...` PR — including the
  // multiple force-pushes Decap fires while saving an entry — cancels
  // the in-flight validate-content run and starts a new one. Treating
  // the first `cancelled` we see as a hard failure makes the publish-
  // loop spec a coin flip: when this poller's first read of `runs[0]`
  // catches the cancelled run before the replacement has been queued,
  // the spec dies even though a successful run is moments away. To
  // dodge that, remember which run IDs we've already seen as cancelled
  // and keep polling for a NEWER run that resolves. Only treat
  // `failure` / `timed_out` as hard failures; `cancelled` is transient.
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  const cancelledSeen = new Set();
  while (Date.now() < deadline) {
    const params = new URLSearchParams();
    if (branch) params.set("branch", branch);
    if (headSha) params.set("head_sha", headSha);
    params.set("per_page", "20");
    const data = await gh(`/repos/${repo}/actions/workflows/${workflow}/runs?${params}`);
    const runs = data.workflow_runs || [];
    if (runs.length > 0) {
      // Don't just look at runs[0]. When two runs have the same
      // created_at (the typical opened+labeled webhook race against
      // a fresh PR), the API consistently returns one ordering of
      // them — and if it returns the cancelled one first, polling
      // runs[0] forever sees only the cancelled run even though a
      // success-conclusion sibling sits at runs[1]. Search the
      // whole returned page for the expected conclusion before
      // falling back to the runs[0] cancellation/failure handling.
      const success = runs.find(
        (r) => r.status === "completed" && r.conclusion === expectedConclusion,
      );
      if (success) return success;

      lastSeen = runs[0];
      if (lastSeen.status === "completed") {
        if (lastSeen.conclusion === "cancelled") {
          // Newer run hopefully on the way. Record the ID so we don't
          // spin on the same cancelled run forever, then keep polling.
          cancelledSeen.add(lastSeen.id);
          console.info(
            `[waitForWorkflowRun] ${workflow} run ${lastSeen.id} on ${branch || headSha} was cancelled — waiting for a newer run to land.`,
          );
        } else {
          // Any other terminal conclusion (failure, timed_out,
          // action_required, etc.) IS a real failure. Surface it
          // immediately rather than waiting for a successor that
          // may never come.
          throw new Error(
            `Workflow ${workflow} on ${branch || headSha} completed with conclusion=${lastSeen.conclusion} (expected ${expectedConclusion}).`,
          );
        }
      }
    }
    await sleep(pollMs);
  }
  throw await augmentTimeoutError(
    new Error(
      `Timed out waiting for ${workflow} on ${branch || headSha}; last seen ${
        lastSeen ? `${lastSeen.status}/${lastSeen.conclusion}` : "no runs"
      }${
        cancelledSeen.size > 0
          ? ` (also saw ${cancelledSeen.size} cancelled run(s) before timeout)`
          : ""
      }.`,
    ),
    {
      waitingFor: `${workflow} on ${branch || headSha} (expected ${expectedConclusion})`,
      kind: "workflow",
    },
  );
}

async function fetchPublicUrl(url, { timeoutMs = 240_000, pollMs = 6_000, expectContent } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const body = await res.text();
        if (!expectContent || body.includes(expectContent)) return body;
      }
    } catch (_) {
      /* network blip — keep polling */
    }
    await sleep(pollMs);
  }
  throw await augmentTimeoutError(
    new Error(
      `Timed out waiting for ${url} to expose ${expectContent ? JSON.stringify(expectContent) : "200 OK"}.`,
    ),
    {
      waitingFor: `URL ${url} to serve ${expectContent ? "expected content" : "200 OK"}`,
      kind: "url",
    },
  );
}

async function getDefaultBranchHeadSha({ repo = HOST_REPO, branch = "main" } = {}) {
  const ref = await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
  return ref.object && ref.object.sha;
}

// #1723 Cat 1: how many deploys currently occupy a deploy lane
// (in_progress + queued). The `production` lane (deploy-production.yml,
// `cancel-in-progress: false`) serializes EVERY deploy repo-wide, so a
// loop spec's own canary deploy can sit queued behind a backlog far
// longer than the per-spec URL-reflect budget sized for one deploy —
// the dominant in-spec timeout flake. Used by makeDeployQueueExtender
// to tell "still draining a backlog" (extend the wait) from "lane idle,
// the chain never fired" (fail fast as a real miss).
async function countActiveDeployRuns({
  repo = HOST_REPO,
  workflow = "deploy-production.yml",
} = {}) {
  let total = 0;
  for (const status of ["in_progress", "queued"]) {
    const data = await gh(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=${status}&per_page=50`,
    );
    total += (data.workflow_runs || []).length;
  }
  return total;
}

// #1723 Cat 1 (refined): a SINGLE-INSTANT in_progress+queued count is too
// blunt. This repo deploys every few minutes, so the lane is often
// momentarily IDLE between deploys — and a budget-exhaustion probe that
// lands in such a gap wrongly concludes "the chain never fired" and fails
// the spec, even though the lane is actively cycling and the spec's own
// deploy is imminent/just-finished (observed: prod-mutate run 26487434047
// — deploys ran at :41/:47/:56 but the probe at :56:19 caught a gap).
//
// So measure lane ACTIVITY over a short window, not one instant:
//   inFlight = in_progress + queued right now
//   recent   = runs created/updated within `recentWindowMs` (a deploy
//              that just completed ⇒ the lane is cycling, not quiescent)
// "Genuinely idle" = inFlight 0 AND recent 0.
//
// #21: the `recent` window is anchored to "now", so once the per-spec
// URL-reflect budget elapses >recentWindowMs AFTER the spec's OWN deploy
// completed, the lane reads quiescent and the extender mis-diagnoses a
// real URL-not-served failure as "chain never fired" (false negative —
// adamdaniel.ai run 26926552300). To judge against the spec's OWN deploy
// instead, pass `mergedAt` (epoch ms or ISO string = the create PR's
// merged_at): the result then also carries
//   runsSinceMerge            = deploy-production runs with created_at >= mergedAt
//   deployCompletedSinceMerge = at least one of those has COMPLETED
// A completed run for THIS merge is conclusive (the deploy fired +
// finished — the failure is URL-not-served, an S3/CloudFront problem),
// regardless of how long ago "now" minus recentWindowMs is.
async function deployLaneActivity({
  repo = HOST_REPO,
  workflow = "deploy-production.yml",
  recentWindowMs = 5 * 60 * 1000,
  mergedAt,
} = {}) {
  const inFlight = await countActiveDeployRuns({ repo, workflow });
  const since = Date.now() - recentWindowMs;
  const data = await gh(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=20`,
  );
  const runs = data.workflow_runs || [];
  const recent = runs.filter((r) => {
    const t = Date.parse(r.updated_at || r.created_at || "");
    return Number.isFinite(t) && t >= since;
  }).length;

  // Anchor on the spec's own deploy when mergedAt is supplied. A
  // numeric epoch-ms or an ISO string are both accepted; an unparseable
  // value falls back to the legacy window-only signal (runsSinceMerge 0).
  let runsSinceMerge = 0;
  let deployCompletedSinceMerge = false;
  const mergedAtMs = typeof mergedAt === "number" ? mergedAt : Date.parse(mergedAt || "");
  if (Number.isFinite(mergedAtMs)) {
    for (const r of runs) {
      const created = Date.parse(r.created_at || "");
      if (!Number.isFinite(created) || created < mergedAtMs) continue;
      runsSinceMerge += 1;
      if (r.status === "completed") deployCompletedSinceMerge = true;
    }
  }
  return { inFlight, recent, runsSinceMerge, deployCompletedSinceMerge };
}

// Build an `onBudgetExhausted` callback for deploy-pill.js's
// waitForChangeReflected (#1723 Cat 1 + #21). When the per-spec
// URL-reflect budget elapses, this probes the deploy lane's ACTIVITY and
// decides whether to extend (backlog draining) or give up (real failure).
//
// #21 — judge against the SPEC'S OWN deploy, not a sliding wall-clock
// window. Pass `mergedAt` (the create PR's merged_at — epoch ms or ISO
// string) or `getMergedAt` (an async getter, used when the merge lands
// DURING the reflect wait so the timestamp isn't known up front). The
// extender then resolves the verdict in priority order:
//   1. a deploy-production run created_at>=mergedAt that COMPLETED
//      → CONCLUSIVE: the deploy fired + finished, so the chain is healthy
//        and the failure is URL-not-served (S3 sync / CloudFront). Stop
//        extending and record verdict { kind: 'deploy-completed-url-
//        missing', realMiss: false }. (The pre-#21 false negative: this
//        used to read "lane QUIESCENT" once >recentWindowMs had elapsed
//        and wrongly declared a real miss.)
//   2. a deploy for this merge still in-flight/queued (or, without a
//      mergedAt, a lane that's in-flight OR recently-active) → return a
//      proportional extension: the backlog is draining / the deploy is
//      imminent; waiting longer is correct, not flaky.
//   3. NO deploy run created_at>=mergedAt AND the lane idle → genuine
//      real miss: the chain never fired. Stop extending and record
//      verdict { kind: 'no-deploy-fired', realMiss: true }.
//   - probe error → grant ONE conservative extension rather than
//     false-failing on a transient API blip.
// The latest verdict is exposed on the returned function as
// `extender.verdict` so deploy-pill.js's timeout message can self-report
// the true failure leg. Bounded by `maxTotalExtendMs` (and by
// waitForChangeReflected's own `maxExtensions` round cap). `activity` is
// injectable for unit tests.
function makeDeployQueueExtender({
  repo = HOST_REPO,
  workflow = "deploy-production.yml",
  perDeployMs = 5 * 60 * 1000,
  minExtendMs = 3 * 60 * 1000,
  maxTotalExtendMs = 30 * 60 * 1000,
  recentWindowMs = 5 * 60 * 1000,
  mergedAt,
  getMergedAt,
  activity,
} = {}) {
  let extendedTotal = 0;
  const resolveMergedAt = async () => {
    if (mergedAt != null && mergedAt !== "") return mergedAt;
    if (typeof getMergedAt === "function") {
      try {
        return await getMergedAt();
      } catch (_) {
        return undefined;
      }
    }
    return undefined;
  };
  const extender = async ({ elapsedMs = 0, extensionCount = 0 } = {}) => {
    const remaining = maxTotalExtendMs - extendedTotal;
    if (remaining <= 0) {
      console.warn(
        `[deploy-queue] hit the ${Math.round(maxTotalExtendMs / 1000)}s extension ceiling for the ${workflow} lane; failing as a real miss.`,
      );
      // Preserve any deploy-completed verdict already recorded; otherwise
      // a stuck lane that never fired is a real miss.
      if (!extender.verdict) extender.verdict = { kind: "no-deploy-fired", realMiss: true };
      return 0;
    }
    const ma = await resolveMergedAt();
    let act;
    try {
      act = activity ? await activity() : await deployLaneActivity({ repo, workflow, recentWindowMs, mergedAt: ma });
    } catch (e) {
      const grant = Math.min(minExtendMs, remaining);
      extendedTotal += grant;
      console.warn(
        `[deploy-queue] could not probe the ${workflow} lane (${e && e.message}); granting a conservative ${Math.round(grant / 1000)}s extension (ext #${extensionCount + 1}).`,
      );
      return grant;
    }
    const inFlight = (act && Number.isFinite(act.inFlight) && act.inFlight) || 0;
    const recent = (act && Number.isFinite(act.recent) && act.recent) || 0;
    const runsSinceMerge = (act && Number.isFinite(act.runsSinceMerge) && act.runsSinceMerge) || 0;
    const deployCompletedSinceMerge = Boolean(act && act.deployCompletedSinceMerge);
    const anchored = ma != null && ma !== "";

    // (1) CONCLUSIVE — the spec's own deploy fired + finished. The failure
    // is URL-not-served, NOT a chain miss. This is the #21 self-diagnosis.
    if (anchored && deployCompletedSinceMerge) {
      extender.verdict = {
        kind: "deploy-completed-url-missing",
        realMiss: false,
        runsSinceMerge,
      };
      console.warn(
        `[deploy-queue] URL still not reflected after ${Math.round(elapsedMs / 1000)}s, but a ${workflow} run created after the merge has COMPLETED — the deploy fired + finished; this is URL-not-served (S3 sync / CloudFront), NOT a chain miss. Failing fast with the right diagnosis (#21).`,
      );
      return 0;
    }

    // (3) Genuine real miss — nothing deploying. When anchored, "nothing
    // for THIS merge" is the precise signal (a PRIOR unrelated deploy in
    // the window does not count); unanchored, fall back to the legacy
    // inFlight/recent quiescence test.
    const idleForMerge = anchored
      ? inFlight <= 0 && runsSinceMerge <= 0
      : inFlight <= 0 && recent <= 0;
    if (idleForMerge) {
      extender.verdict = { kind: "no-deploy-fired", realMiss: true };
      console.warn(
        `[deploy-queue] URL still not reflected after ${Math.round(elapsedMs / 1000)}s and ${
          anchored
            ? `NO ${workflow} run fired for this merge`
            : `the ${workflow} lane is QUIESCENT (0 in flight, 0 in the last ${Math.round(recentWindowMs / 1000)}s)`
        } — the deploy-triggering chain never fired; failing as a real miss.`,
      );
      return 0;
    }

    // (2) Active or recently-cycling / deploy queued for the merge: extend.
    extender.verdict = { kind: "deploy-in-flight", realMiss: false, runsSinceMerge };
    const units = Math.max(inFlight, anchored ? runsSinceMerge : 0, 1);
    const grant = Math.min(Math.max(perDeployMs * units, minExtendMs), remaining);
    extendedTotal += grant;
    console.warn(
      `[deploy-queue] URL not yet reflected after ${Math.round(elapsedMs / 1000)}s, but the ${workflow} lane is active (${inFlight} in flight, ${recent} recent, ${runsSinceMerge} for this merge) — extending ${Math.round(grant / 1000)}s (ext #${extensionCount + 1}, ${Math.round(extendedTotal / 1000)}s total).`,
    );
    return grant;
  };
  // The latest verdict the extender reached — consumed by deploy-pill.js
  // to self-report the true failure leg. null until the extender runs.
  extender.verdict = null;
  return extender;
}

// Port of cms-automerge-nudge.yml's headIsTrulyGreen (:205-260) as a pure
// JS helper, using the raw gh() fetch wrapper. Returns { ok, why? }.
// `requiredContexts` is the FEATURE-BRANCH ruleset's required check set
// (the cms-feature-branches ruleset stores it as the BARE name
// 'validate-content') — deliberately a strict subset/different list from
// main.json; callers must NOT pass the larger cron-nudge/main list
// (e2e-admin, preview-media, finalize…), which the feature-branch ruleset
// never enforces and which would never appear on a cms/* sub-PR head sha →
// permanent "missing on head sha".
//
// CORRECTION #1 — suffix-tolerant context matching. The ruleset stores the
// required check as the bare context `validate-content`, but the actual
// check-RUN posted on a cms/* PR head sha is named `editorial /
// validate-content` (workflow / job). An EXACT name match would find
// nothing → "missing on head sha" → recovery never fires. So a required
// context `ctx` matches a check-run (or legacy status) whose name EITHER
// === ctx OR whose last ` / `-separated segment === ctx (e.g.
// 'editorial / validate-content'.split(' / ').pop().trim() ===
// 'validate-content'). requiredContexts stays the bare ['validate-content']
// (aligns with the stored context); the tolerant match finds the prefixed
// check-run.
async function headChecksTrulyGreen({ repo = HOST_REPO, sha, requiredContexts, _gh = gh } = {}) {
  const required = (requiredContexts || []).filter(Boolean);
  if (!sha) return { ok: false, why: "no head sha" };
  if (required.length === 0) throw new Error("headChecksTrulyGreen needs a non-empty requiredContexts.");
  const GREEN = (c) => c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED";
  // A required context matches a check-run/status name exactly, OR matches
  // its last ` / `-separated segment (so the bare ruleset context
  // `validate-content` matches the `editorial / validate-content`
  // check-run). See CORRECTION #1 above.
  const matchesCtx = (name, ctx) =>
    name === ctx || String(name).split(" / ").pop().trim() === ctx;

  const byName = new Map();
  for (let page = 1; ; page++) {
    const data = await _gh(
      `/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&page=${page}`,
    );
    const runs = data.check_runs || [];
    for (const r of runs) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
    if (runs.length < 100) break;
  }
  const legacy = new Map();
  try {
    const data = await _gh(`/repos/${repo}/commits/${encodeURIComponent(sha)}/status`);
    for (const s of data.statuses || []) legacy.set(s.context, (s.state || "").toUpperCase());
  } catch (_) { /* no legacy statuses */ }

  for (const ctx of required) {
    // Gather every check-run whose name matches this required context
    // (tolerant of the `workflow / job` prefix — CORRECTION #1).
    const runs = [];
    for (const [name, list] of byName) {
      if (matchesCtx(name, ctx)) runs.push(...list);
    }
    if (runs.length) {
      // (A) STUB HAZARD: never merge while a required run is queued/in-progress.
      const pending = runs.find((r) => r.status !== "completed");
      if (pending) return { ok: false, why: `${ctx} still ${pending.status}` };
      // Ignore CANCELLED (same-sha label-burst residue); decide on latest non-cancelled.
      const decisive = runs
        .filter((r) => (r.conclusion || "").toLowerCase() !== "cancelled")
        .sort((a, b) => new Date(a.started_at || 0) - new Date(b.started_at || 0))
        .pop();
      if (!decisive) return { ok: false, why: `${ctx}: all runs cancelled` };
      if (!GREEN((decisive.conclusion || "").toUpperCase())) return { ok: false, why: `${ctx}=${decisive.conclusion}` };
      continue;
    }
    // No check-run matched — fall back to the legacy commit-status API,
    // also tolerant of the prefixed context name.
    let st;
    for (const [context, state] of legacy) {
      if (matchesCtx(context, ctx)) {
        st = state;
        break;
      }
    }
    if (st === undefined) return { ok: false, why: `${ctx} missing on head sha` };
    if (!GREEN(st)) return { ok: false, why: `${ctx}=${st}` };
  }
  return { ok: true };
}

// onBudgetExhausted recoverer for the PREVIEW loops (#82). When the URL
// hasn't reflected and the budget elapsed, fresh-requery the loop's OWN
// canary sub-PR and, if it's green-but-stuck-BLOCKED, force a synchronous
// SQUASH merge into the preview branch (its own base) — the proven nudge
// recovery for the #1812/#1815 stale snapshot. Mirrors makeDeployQueueExtender's
// (ctx)=>Promise<number> contract + .verdict self-report.
function makePreviewCanaryRecoverer({
  repo = HOST_REPO,
  base, // PR_HEAD_REF — the preview branch (for the D guard)
  requiredContexts = ["validate-content"],
  getPrNumber, // number | () => number | Promise<number>
  perDeployMs = 5 * 60 * 1000,
  minExtendMs = 3 * 60 * 1000,
  maxTotalExtendMs = 30 * 60 * 1000,
  _gh = gh,
  _headChecksTrulyGreen = headChecksTrulyGreen,
} = {}) {
  if (!base) throw new Error("makePreviewCanaryRecoverer requires base (the preview head branch).");
  if (getPrNumber == null) throw new Error("makePreviewCanaryRecoverer requires getPrNumber.");
  let extendedTotal = 0;
  const resolvePr = async () => (typeof getPrNumber === "function" ? await getPrNumber() : getPrNumber);
  const recoverer = async () => {
    const remaining = maxTotalExtendMs - extendedTotal;
    if (remaining <= 0) {
      recoverer.verdict = { kind: "no-deploy-fired", realMiss: true };
      return 0;
    }
    const grant = (ms) => {
      const g = Math.min(Math.max(ms, minExtendMs), remaining);
      extendedTotal += g;
      return g;
    };

    let prNumber;
    try {
      prNumber = await resolvePr();
    } catch (_) {
      prNumber = null;
    }
    if (!prNumber) {
      recoverer.verdict = { kind: "no-pr-yet", realMiss: false };
      return grant(minExtendMs);
    }

    let pr;
    try {
      pr = await _gh(`/repos/${repo}/pulls/${prNumber}`);
    } catch (_) {
      recoverer.verdict = { kind: "probe-error", realMiss: false };
      return grant(minExtendMs);
    }

    // (B) idempotency — already landed: ride out deploy-preview + CDN, never re-merge.
    if (pr.merged || pr.merged_at) {
      recoverer.verdict = { kind: "merged-awaiting-deploy", realMiss: false };
      return grant(perDeployMs);
    }
    if (pr.state === "closed") {
      recoverer.verdict = { kind: "canary-closed", realMiss: true };
      return 0;
    }

    // (D) OUR canary only: cms/* head, base === preview branch, automated-test label.
    const head = (pr.head && pr.head.ref) || "";
    const baseRef = (pr.base && pr.base.ref) || "";
    const isAutomated =
      Array.isArray(pr.labels) && pr.labels.some((l) => (l && (l.name || l)) === "automated-test");
    if (!head.startsWith("cms/") || baseRef !== base || !isAutomated) {
      recoverer.verdict = { kind: "not-our-canary", realMiss: false };
      return grant(minExtendMs);
    }

    // (A) fresh authority gate — every required preview context COMPLETED+green, none pending.
    let fresh;
    try {
      fresh = await _headChecksTrulyGreen({ repo, sha: pr.head && pr.head.sha, requiredContexts });
    } catch (_) {
      recoverer.verdict = { kind: "probe-error", realMiss: false };
      return grant(minExtendMs);
    }
    if (!fresh.ok) {
      recoverer.verdict = { kind: "checks-not-green", why: fresh.why, realMiss: false };
      return grant(perDeployMs);
    }

    // Green-but-open ⇒ the #82 stuck-BLOCKED canary. Explicit SQUASH merge
    // into its own base (the preview branch) re-evaluates mergeability fresh.
    try {
      await _gh(`/repos/${repo}/pulls/${prNumber}/merge`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merge_method: "squash" }),
        retries: 3,
      });
      recoverer.verdict = { kind: "recovery-merged", realMiss: false };
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/already merged/i.test(msg)) recoverer.verdict = { kind: "merged-awaiting-deploy", realMiss: false };
      else recoverer.verdict = { kind: "merge-retry", why: msg, realMiss: false }; // transient 405/409 → next round retries
    }
    return grant(perDeployMs); // await deploy-preview + URL reflect
  };
  recoverer.verdict = null;
  return recoverer;
}

module.exports = {
  addLabel,
  countActiveDeployRuns,
  deployLaneActivity,
  fetchPublicUrl,
  getDefaultBranchHeadSha,
  getPullRequest,
  gh,
  headChecksTrulyGreen,
  makeDeployQueueExtender,
  makePreviewCanaryRecoverer,
  waitForAutoMergeEnabled,
  waitForCmsPullRequest,
  waitForMerge,
  waitForWorkflowRun,
};
