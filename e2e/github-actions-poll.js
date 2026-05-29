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

async function addLabel({ repo = HOST_REPO, prNumber, label }) {
  // Mutating POST — opt into the bounded transient-retry (#1771 step 1).
  // The read-pollers keep the default retries:0 because they already
  // loop on their own deadlines.
  return gh(`/repos/${repo}/issues/${prNumber}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [label] }),
    retries: 5,
  });
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
async function deployLaneActivity({
  repo = HOST_REPO,
  workflow = "deploy-production.yml",
  recentWindowMs = 5 * 60 * 1000,
} = {}) {
  const inFlight = await countActiveDeployRuns({ repo, workflow });
  const since = Date.now() - recentWindowMs;
  const data = await gh(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=20`,
  );
  const recent = (data.workflow_runs || []).filter((r) => {
    const t = Date.parse(r.updated_at || r.created_at || "");
    return Number.isFinite(t) && t >= since;
  }).length;
  return { inFlight, recent };
}

// Build an `onBudgetExhausted` callback for deploy-pill.js's
// waitForChangeReflected (#1723 Cat 1). When the per-spec URL-reflect
// budget elapses, this probes the deploy lane's ACTIVITY:
//   - lane in-flight OR recently-active → return a proportional extension
//     (the spec's own deploy is queued behind a backlog, or the lane is
//     cycling and its deploy is imminent/just-landed; waiting longer is
//     correct, not flaky).
//   - lane genuinely quiescent (0 in flight AND 0 recent) → return 0
//     (give up): nothing is deploying or has deployed lately, so the
//     change's chain never fired — surface it as a REAL miss, fast.
//   - probe error → grant ONE conservative extension rather than
//     false-failing on a transient API blip.
// Bounded by `maxTotalExtendMs` (and by waitForChangeReflected's own
// `maxExtensions` round cap) so a genuinely stuck lane can't wait
// forever. `activity` is injectable for unit tests.
function makeDeployQueueExtender({
  repo = HOST_REPO,
  workflow = "deploy-production.yml",
  perDeployMs = 5 * 60 * 1000,
  minExtendMs = 3 * 60 * 1000,
  maxTotalExtendMs = 30 * 60 * 1000,
  recentWindowMs = 5 * 60 * 1000,
  activity,
} = {}) {
  const probeActivity = activity || (() => deployLaneActivity({ repo, workflow, recentWindowMs }));
  let extendedTotal = 0;
  return async ({ elapsedMs = 0, extensionCount = 0 } = {}) => {
    const remaining = maxTotalExtendMs - extendedTotal;
    if (remaining <= 0) {
      console.warn(
        `[deploy-queue] hit the ${Math.round(maxTotalExtendMs / 1000)}s extension ceiling for the ${workflow} lane; failing as a real miss.`,
      );
      return 0;
    }
    let act;
    try {
      act = await probeActivity();
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
    if (inFlight <= 0 && recent <= 0) {
      console.warn(
        `[deploy-queue] URL still not reflected after ${Math.round(elapsedMs / 1000)}s and the ${workflow} lane is QUIESCENT (0 in flight, 0 in the last ${Math.round(recentWindowMs / 1000)}s) — not a backlog; failing as a real miss.`,
      );
      return 0;
    }
    // Active or recently-cycling: scale the extension by what's in flight
    // (at least one deploy's worth when only recent activity is seen).
    const units = Math.max(inFlight, 1);
    const grant = Math.min(Math.max(perDeployMs * units, minExtendMs), remaining);
    extendedTotal += grant;
    console.warn(
      `[deploy-queue] URL not yet reflected after ${Math.round(elapsedMs / 1000)}s, but the ${workflow} lane is active (${inFlight} in flight, ${recent} in the last ${Math.round(recentWindowMs / 1000)}s) — extending ${Math.round(grant / 1000)}s (ext #${extensionCount + 1}, ${Math.round(extendedTotal / 1000)}s total).`,
    );
    return grant;
  };
}

module.exports = {
  addLabel,
  countActiveDeployRuns,
  deployLaneActivity,
  fetchPublicUrl,
  getDefaultBranchHeadSha,
  getPullRequest,
  gh,
  makeDeployQueueExtender,
  waitForAutoMergeEnabled,
  waitForCmsPullRequest,
  waitForMerge,
  waitForWorkflowRun,
};
