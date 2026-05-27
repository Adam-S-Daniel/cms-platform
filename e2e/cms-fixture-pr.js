/*
 * Helpers that seed and tear down throw-away `_e2e/` fixtures via a real
 * PR + auto-merge round-trip, instead of writing to main directly.
 *
 * Why: the `pull_request` rule on the main branch
 * (.github/rulesets/main.json) rejects every direct write to main with
 * a 409 "Repository rule violations found". The publish-loop and
 * delete-published specs used to call PUT /contents/{path} on main for
 * setup/cleanup; that path is permanently blocked. These helpers route
 * the same writes through the cms-editorial-workflow auto-merge
 * pipeline that prod already uses for content edits:
 *
 *   1. POST /git/refs    — create a branch off the current main HEAD
 *   2. PUT /contents     — commit the fixture on that branch
 *   3. POST /pulls       — open a PR with base=main
 *   4. POST /labels      — apply `cms/ready`
 *   5. cms-editorial-workflow.yml fires `auto-merge-when-ready`, which
 *      enables auto-merge; once `validate-content` + the e2e/test
 *      checks finish, the PR squash-merges itself
 *   6. waitForMerge      — block until the merge actually lands
 *
 * Branch naming is `cms/e2e-fixture/<slug>-<runId>` so the cleanup
 * workflow can recognise stale leftovers and the cms-editorial-workflow
 * `cms/draft` labeller (which keys off `cms/`) still applies.
 *
 * Used by:
 *   - e2e/cms-publish-loop.spec.js  (baseline reset + post-run cleanup)
 *   - e2e/cms-delete-published.spec.js  (throw-away fixture seed)
 */
const { HOST_REPO } = require("./decap-pat");
const { gh, getDefaultBranchHeadSha, waitForMerge } = require("./github-actions-poll");

const FIXTURE_BRANCH_PREFIX = "cms/e2e-fixture";

function toContentBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function fixtureBranchName({ slug, runId, action }) {
  // `action` is "seed" or "remove" — included so the same `slug` can
  // have both a seed and a remove branch open at once without clashing.
  return `${FIXTURE_BRANCH_PREFIX}/${action}-${slug}-${runId}`;
}

/**
 * Create a fresh branch at the current main HEAD. If a branch with the
 * same name already exists (e.g., this is a retry of the same runId),
 * delete it and recreate from HEAD so we always commit on top of the
 * latest main.
 */
async function createBranchFromMain({ repo, branch }) {
  const sha = await getDefaultBranchHeadSha({ repo, branch: "main" });
  // Best-effort delete first so retries don't trip on a stale branch.
  try {
    await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "DELETE",
    });
  } catch (_) {
    /* branch didn't exist — fine */
  }
  await gh(`/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  return sha;
}

/**
 * PUT a file on `branch`. Auto-detects whether the file already exists
 * on that branch (a seed branch was just created off main, so the file
 * may or may not be present depending on whether we're updating an
 * existing canary baseline or creating a brand-new throw-away fixture).
 */
async function putFileOnBranch({ repo, branch, filePath, bodyText, message }) {
  let sha;
  try {
    const existing = await gh(
      `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
    );
    sha = existing.sha;
  } catch (e) {
    if (!/\b404\b/.test(String(e.message))) throw e;
    // File doesn't exist on this branch yet — that's fine, we'll create.
  }
  const payload = {
    message,
    content: toContentBase64(bodyText),
    branch,
  };
  if (sha) payload.sha = sha;
  return gh(`/repos/${repo}/contents/${filePath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * DELETE a file on `branch`. Used by the remove-fixture path. Returns
 * the commit info GitHub returns from the contents-delete endpoint.
 */
async function deleteFileOnBranch({ repo, branch, filePath, message }) {
  const existing = await gh(
    `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
  );
  return gh(`/repos/${repo}/contents/${filePath}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      sha: existing.sha,
      branch,
    }),
  });
}

async function openPr({ repo, branch, title, body }) {
  return gh(`/repos/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      head: branch,
      base: "main",
      body,
    }),
  });
}

async function addReadyLabel({ repo, prNumber }) {
  return gh(`/repos/${repo}/issues/${prNumber}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: ["cms/ready"] }),
  });
}

/** Close any open PR(s) on a fixed Decap-managed head branch
 * (`cms/<col>/<slug>`), then delete the branch. Used at the start of
 * publish-loop specs to wipe leftover state from a prior run. The
 * symptom this prevents: Decap reuses a fixed branch per entry. If a
 * prior run left a PR with a non-Draft editorial-workflow label
 * (decap-cms/pending_publish, decap-cms/pending_review, decap-cms/ready),
 * the next run's Save pushes onto the same branch — labels persist —
 * Decap UI shows "Status: Ready" instead of "Status: Draft" — the
 * spec's button-wait times out at 20 min. Closing the PR + deleting
 * the branch resets to a clean slate; Decap opens a fresh
 * decap-cms/draft on the next Save.
 *
 * Best-effort: any sub-step (list / close / delete) that fails is
 * swallowed. If we can't reset cleanly, the spec's existing failure
 * paths surface the issue downstream — no need to short-circuit
 * here on a transient list-pulls error.
 */
async function closeStaleDecapPrOnBranch({ repo = HOST_REPO, branch }) {
  if (!branch) return;
  let prs;
  try {
    const owner = repo.split("/")[0];
    prs = await gh(`/repos/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`);
  } catch (_) {
    return;
  }
  if (!Array.isArray(prs) || prs.length === 0) return;
  for (const pr of prs) {
    await closePrAndDeleteBranch({
      repo,
      prNumber: pr.number,
      branch,
    });
  }
}

/** Best-effort PR close + branch delete. Used when a fixture flow times
 * out; leaves the repo cleaner than an open zombie PR but doesn't
 * throw if either step fails — the cleanup workflow picks up the
 * branch later anyway. */
async function closePrAndDeleteBranch({ repo, prNumber, branch }) {
  if (prNumber) {
    try {
      await gh(`/repos/${repo}/pulls/${prNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
    } catch (_) {
      /* ignore */
    }
  }
  try {
    await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "DELETE",
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Seed a fixture file on main via a labelled PR.
 *
 * Opens a `cms/e2e-fixture/seed-<slug>-<runId>` PR, labels it cms/ready
 * to engage the auto-merge-when-ready job, then blocks until the PR
 * merges. On timeout closes the PR and deletes the branch so the next
 * run starts clean.
 *
 * Returns the merged PR object (with `merge_commit_sha` populated).
 */
async function seedFixtureViaPr({
  repo = HOST_REPO,
  slug,
  runId,
  filePath,
  bodyText,
  message,
  prTitle,
  prBody,
  // Bumped from 12 → 18 min on 2026-05-07 after run #25468384439
  // showed 12 min wasn't enough headroom: PR #252 had auto-merge
  // enabled at +7 sec but the required-check matrix
  // (validate-content + scan + select + unit + parity + e2e (1) +
  // finalize) took longer than 12 min to all complete green when
  // runners were busy (concurrent host-loop run holding shards).
  // The PR was at "all checks pass + auto-merge enabled" state
  // moments after this throws, but the spec had already given up
  // and closed it. 18 min covers normal-busy queue depth without
  // pushing the spec's TEST_TIMEOUT_MS into needing a parallel
  // bump.
  timeoutMs = 25 * 60 * 1000,
  // Fire-and-forget mode for harness-cleanup paths (e.g. the
  // afterAll safety-net in cms-publish-loop.spec.js). When true,
  // return as soon as the PR is opened + labelled — don't wait
  // for the merge. The editorial-workflow auto-merges in the
  // background; the daily sweep cleans up any orphan PR that
  // can't merge (empty diff because another worker raced ahead,
  // CI failure, etc.). Default false — production callers in
  // the spec's own cleanup leg need the wait-for-merge guarantee.
  skipWaitForMerge = false,
} = {}) {
  if (!slug || !runId || !filePath || !bodyText || !message) {
    throw new Error("seedFixtureViaPr requires slug, runId, filePath, bodyText, and message.");
  }
  const branch = fixtureBranchName({ slug, runId, action: "seed" });
  let pr;
  try {
    await createBranchFromMain({ repo, branch });
    await putFileOnBranch({ repo, branch, filePath, bodyText, message });
    pr = await openPr({
      repo,
      branch,
      title: prTitle || `test(canary): seed ${filePath} for run ${runId}`,
      body:
        prBody ||
        `Automated fixture seed for the e2e publish-loop / delete-published spec (run \`${runId}\`).\n\n` +
          `Branch: \`${branch}\`. Auto-merges via the \`cms/ready\` label once \`validate-content\` + the e2e shards land.`,
    });
    await addReadyLabel({ repo, prNumber: pr.number });
    if (skipWaitForMerge) {
      // Caller doesn't care when the PR merges, only that it's
      // open and queued for auto-merge. Return the open PR
      // descriptor; the editorial-workflow handles the rest.
      return pr;
    }
    return await waitForMerge({ repo, prNumber: pr.number, timeoutMs });
  } catch (e) {
    await closePrAndDeleteBranch({
      repo,
      prNumber: pr && pr.number,
      branch,
    });
    throw e;
  }
}

/**
 * Remove a fixture file from main via a labelled PR.
 *
 * Mirror of seedFixtureViaPr but deletes instead of writes. Used by
 * cms-publish-loop / cms-delete-published cleanup paths when the file
 * needs to come off main and the direct-DELETE path would hit the
 * ruleset.
 */
async function removeFixtureViaPr({
  repo = HOST_REPO,
  slug,
  runId,
  filePath,
  message,
  prTitle,
  prBody,
  // Same headroom as seedFixtureViaPr (18 min) — both go through the
  // identical full required-check matrix on the host repo's main
  // ruleset.
  timeoutMs = 25 * 60 * 1000,
  // Fire-and-forget mode for harness-cleanup paths (the afterAll
  // safety-nets in the ephemeral prod canaries). When true, return as
  // soon as the removal PR is opened + labelled — do NOT block on
  // waitForMerge. Playwright's default hook timeout is 30s; the
  // 25-minute waitForMerge below would blow it (the ephemeral
  // prod-mutate run's afterAll timed out at exactly this). The
  // editorial-workflow auto-merges the removal PR in the background;
  // the daily sweep (sweep-stale-cms-prs.yml) reaps any orphan PR that
  // can't merge. Mirrors seedFixtureViaPr's identical option. Default
  // false — the spec's own forward cleanup leg still wants the wait.
  skipWaitForMerge = false,
} = {}) {
  if (!slug || !runId || !filePath || !message) {
    throw new Error("removeFixtureViaPr requires slug, runId, filePath, and message.");
  }
  const branch = fixtureBranchName({ slug, runId, action: "remove" });
  let pr;
  try {
    await createBranchFromMain({ repo, branch });
    await deleteFileOnBranch({ repo, branch, filePath, message });
    pr = await openPr({
      repo,
      branch,
      title: prTitle || `test(canary): remove ${filePath} for run ${runId}`,
      body:
        prBody ||
        `Automated fixture cleanup for the e2e publish-loop / delete-published spec (run \`${runId}\`).\n\n` +
          `Branch: \`${branch}\`. Auto-merges via the \`cms/ready\` label once required checks land.`,
    });
    await addReadyLabel({ repo, prNumber: pr.number });
    if (skipWaitForMerge) {
      // Caller doesn't care when the PR merges, only that it's open and
      // queued for auto-merge. Return the open PR descriptor; the
      // editorial-workflow handles the rest.
      return pr;
    }
    return await waitForMerge({ repo, prNumber: pr.number, timeoutMs });
  } catch (e) {
    await closePrAndDeleteBranch({
      repo,
      prNumber: pr && pr.number,
      branch,
    });
    throw e;
  }
}

module.exports = {
  FIXTURE_BRANCH_PREFIX,
  fixtureBranchName,
  seedFixtureViaPr,
  removeFixtureViaPr,
  closeStaleDecapPrOnBranch,
  // Exported for unit tests / debugging
  createBranchFromMain,
  putFileOnBranch,
  deleteFileOnBranch,
};
