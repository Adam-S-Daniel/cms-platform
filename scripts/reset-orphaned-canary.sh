#!/usr/bin/env bash
# Idempotent self-heal for orphaned publish-loop canary markers.
#
# The publish loops (cms-publish-loop-host.yml / cms-publish-loop-prod.yml
# / cms-publish-loop-preview.yml) inject a transient marker —
# `e2e-publish-loop:<id>:<runId>` — into a `_e2e/` canary source file,
# drive a Decap → cms-PR → auto-merge → deploy round trip, then reset the
# file back to its canonical baseline in cleanup.
#
# If a run is INTERRUPTED (cancelled / errored) before that cleanup runs,
# it leaves the marker committed on the loop's working ref. For the host /
# prod loops that ref is `main`: the byte-lock invariant in
# e2e/canary-content.test.js then (correctly) fails, and because the
# required e2e check is path-filtered it may not re-report, wedging the
# whole lane (see adamdaniel.ai#1861, which had to be unwedged by hand).
# For the preview loop the working ref is the PR head feature branch — a
# leftover marker there has no required-check blast radius (the branch is
# deleted when the parent PR closes) but can still confuse the next run's
# forward leg, so we heal it too for consistency.
#
# This script runs VERY EARLY in each loop job, BEFORE a fresh marker is
# injected, and resets any canary whose body still carries a leftover
# marker back to the canonical baseline. It reuses the existing harness
# (e2e/canary-content.js for the baseline body) so there is no second
# copy of the baseline text.
#
# Two write regimes, selected by CANARY_RESET_BRANCH:
#   - UNSET (host / prod, target = main): direct writes to main are
#     blocked by the main-branch ruleset, so the reset goes through the
#     SAME `cms/ready` labelled-PR + auto-merge path the spec's own
#     setup-reset uses (e2e/cms-fixture-pr.js::seedFixtureViaPr).
#   - SET to a branch (preview, target = PR head): the feature branch is
#     unprotected, so the reset is a direct Contents-API PUT on that
#     branch — exactly what cms-publish-loop-preview.spec.js does.
#
# Contract: FAIL-OPEN. A clean repo, a missing PAT, or any API hiccup
# must NEVER break the loop — every exit path here is 0. The worst case
# of a no-op is that the pre-existing spec-side setup-reset (step 0) and
# the byte-lock check behave exactly as they do today; the best case is
# the lane is un-wedged before the heavy run even starts.
#
# IDEMPOTENT: it writes only for a canary whose CURRENT body on the target
# ref actually contains a marker. On an already-clean canary it does
# nothing; running it twice back-to-back is a no-op the second time.
#
# Usage: scripts/reset-orphaned-canary.sh
#   Env:
#     CMS_E2E_PAT          fine-grained PAT (contents + pull_requests r/w).
#                          When empty the script no-ops (forks / Dependabot
#                          land here, mirroring the spec self-skip).
#     CMS_REPO /           owner/name of the host repo whose ref carries
#     GITHUB_REPOSITORY    the canary files. Falls back to the harness
#                          default.
#     CANARY_RESET_BRANCH  optional. Unset → heal `main` via a labelled PR.
#                          Set → heal that branch via a direct PUT.
#
# The script lives in the PLATFORM repo; the loops check the platform out
# into `.cms-platform/`, so at runtime this is
# `.cms-platform/scripts/reset-orphaned-canary.sh` and the harness it
# requires is its sibling `.cms-platform/e2e/`. The e2e dir is resolved
# relative to THIS script so the caller's CWD is irrelevant.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
E2E_DIR="$(cd -- "${SCRIPT_DIR}/../e2e" >/dev/null 2>&1 && pwd)" || E2E_DIR=""

if [ -z "${CMS_E2E_PAT:-}" ]; then
  echo "::notice::reset-orphaned-canary: CMS_E2E_PAT empty — skipping self-heal (nothing to write with)."
  exit 0
fi

if [ -z "${E2E_DIR}" ] || [ ! -f "${E2E_DIR}/canary-content.js" ] || [ ! -f "${E2E_DIR}/cms-fixture-pr.js" ]; then
  echo "::notice::reset-orphaned-canary: e2e harness not found next to script — skipping self-heal (fail-open)."
  exit 0
fi

# All the real work is a small Node program that reuses the harness
# modules. It is wrapped so that ANY throw (network, auth, missing file)
# becomes a `::warning::` + exit 0 — the loop must never break on the
# self-heal. node is required by every loop job (npm ci + playwright)
# before this step runs.
E2E_DIR="${E2E_DIR}" node -e '
  const path = require("path");
  const e2eDir = process.env.E2E_DIR;
  const { CANARIES, buildBaselineBody } = require(path.join(e2eDir, "canary-content.js"));
  const { gh } = require(path.join(e2eDir, "github-actions-poll.js"));
  const { seedFixtureViaPr } = require(path.join(e2eDir, "cms-fixture-pr.js"));
  const { HOST_REPO } = require(path.join(e2eDir, "decap-pat.js"));

  // Honour the caller-supplied repo (consuming sites set CMS_REPO via
  // github.repository) and fall back to the harness default, mirroring
  // e2e/base.js. The seedFixtureViaPr default also resolves to HOST_REPO,
  // but we pass it explicitly so the log line and the write target agree.
  const repo = process.env.CMS_REPO || process.env.GITHUB_REPOSITORY || HOST_REPO;
  // Unset → heal main via a labelled PR (ruleset blocks direct writes).
  // Set → heal that feature branch via a direct Contents-API PUT.
  const branch = (process.env.CANARY_RESET_BRANCH || "").trim();
  const ref = branch || "main";
  // MUST match e2e/canary-content.js MARKER_SRC (single source of truth for
  // the marker shape across the byte-lock, the publish-loop afterAll orphan
  // check, and this self-heal). Dash-joined lowercase id, no leading/trailing
  // dash (post / preview-page / spike-project).
  const MARKER_RE = /e2e-publish-loop:[a-z]+(?:-[a-z]+)*:\d+/;

  function toBase64(text) {
    return Buffer.from(text, "utf8").toString("base64");
  }

  // Build the healed file: front matter verbatim + canonical baseline
  // body. Matches the byte-lock invariant byte-for-byte.
  function healedFile(decoded, baseline) {
    const fmEnd = decoded.indexOf("\n---\n", 4);
    if (fmEnd < 0) return null;
    const frontMatter = decoded.slice(0, fmEnd + 5);
    return `${frontMatter}\n${buildBaselineBody(baseline)}\n`;
  }

  async function healViaPr(c, newFile) {
    const runId = `orphan-heal-${Date.now()}`;
    await seedFixtureViaPr({
      repo,
      slug: c.slug,
      runId,
      filePath: c.path,
      bodyText: newFile,
      message: `test(canary): self-heal reset of ${c.slug} baseline (orphaned publish-loop marker)`,
      prTitle: `test(canary): self-heal ${c.slug} (orphaned publish-loop marker)`,
      prBody:
        `An earlier publish-loop run was interrupted before cleanup and left an ` +
        `\`e2e-publish-loop:\` marker in \`${c.path}\`, which wedges the byte-lock ` +
        `invariant (e2e/canary-content.test.js). This auto-merged PR resets the ` +
        `canary body to its canonical baseline so the lane starts clean.`,
    });
  }

  async function healViaPut(c, newFile, sha) {
    await gh(`/repos/${repo}/contents/${c.path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `test(canary): self-heal reset of ${c.slug} baseline (orphaned publish-loop marker)`,
        content: toBase64(newFile),
        sha,
        branch,
      }),
    });
  }

  (async () => {
    let healed = 0;
    for (const c of CANARIES) {
      let current;
      try {
        current = await gh(`/repos/${repo}/contents/${c.path}?ref=${encodeURIComponent(ref)}`);
      } catch (e) {
        // A 404 means the canary file is not present on this ref (a
        // consuming site may not carry every canary; a feature branch may
        // pre-date it) — nothing to heal.
        console.log(`[reset-orphaned-canary] ${c.path}@${ref}: skip (${(e && e.message) || e})`);
        continue;
      }
      const decoded = Buffer.from(current.content, "base64").toString("utf8");
      if (!MARKER_RE.test(decoded)) {
        console.log(`[reset-orphaned-canary] ${c.path}@${ref}: clean (no leftover marker).`);
        continue;
      }
      const newFile = healedFile(decoded, c.baseline);
      if (newFile === null) {
        console.warn(`[reset-orphaned-canary] ${c.path}@${ref}: no closing front-matter delimiter — skip.`);
        continue;
      }
      console.warn(
        `[reset-orphaned-canary] ${c.path}@${ref}: leftover publish-loop marker found — ` +
          `resetting to baseline (${branch ? "direct PUT" : "labelled PR"}).`,
      );
      if (branch) {
        await healViaPut(c, newFile, current.sha);
      } else {
        await healViaPr(c, newFile);
      }
      healed += 1;
    }
    if (healed === 0) {
      console.log(`[reset-orphaned-canary] no orphaned markers on ${ref} — nothing to heal.`);
    } else {
      console.log(`[reset-orphaned-canary] reset ${healed} orphaned canary file(s) on ${ref}.`);
    }
  })().catch((e) => {
    // Fail-open: never break the loop on the self-heal. The spec-side
    // setup-reset (step 0) + the byte-lock check remain the backstop.
    console.warn(
      `::warning::reset-orphaned-canary: self-heal errored (continuing, fail-open): ${(e && e.stack) || e}`,
    );
    process.exit(0);
  });
' || {
  echo "::warning::reset-orphaned-canary: node invocation failed (continuing, fail-open)."
  exit 0
}
