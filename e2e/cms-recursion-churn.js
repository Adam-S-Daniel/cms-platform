// @lane: local — pure data + decision; no browser, no network, no fs
/*
 * Single source of truth for each real-prod loop's *self-churn* set —
 * the paths a loop's own specs mutate and that Decap then auto-merges
 * back to `main` as a normal part of running the loop. The
 * `.github/actions/cms-recursion-gate` composite calls `shouldRunLoop()`
 * to decide, on a `push` to main, whether the push is the loop feeding
 * itself (every changed file ∈ this set ⇒ SKIP) or carries a real
 * machinery change (anything else ⇒ RUN).
 *
 * Why this replaces the old `publish: ` head-commit guard: the guard
 * assumed every loop merge lands via cms-editorial-workflow.yml's
 * `enablePullRequestAutoMerge` `commitHeadline: "publish: …"`. It does
 * not. Decap's synchronous "Publish Now" squash and its git-data-API
 * delete land the canary on `main` with Decap's own
 * `Update {{collection}} "{{slug}}"` / `Delete …` template — no
 * `publish: ` prefix — so the guard never matched and the loop re-fired
 * itself (e.g. cms-unpublish-republish.spec.js's
 * `_posts/2024-01-02-e2e-unpublish-canary.md` merges land as
 * `Update Post "…"`). A changed-files gate is message-format
 * independent and also closes the symmetric latent false-skip the
 * message guard had on a real `publish: ` squash that also touched
 * machinery.
 *
 * Keep each entry annotated with the spec that churns it; the
 * cross-check in e2e/cms-recursion-churn.test.js asserts every spec's
 * FIXTURE_PATH is covered so this can't silently drift.
 */
const { CANARIES } = require("./canary-content");

// _e2e/canary-{post,page,project}.md — reuse the descriptors so this
// list can never drift from canary-content.js (single source).
const CANARY_PATHS = CANARIES.map((c) => c.path);

// loop key → glob patterns. `*` matches WITHIN one path segment only
// (never `/`); every pattern is full-path anchored. The only globs
// here are exact paths plus one `prefix-*.<ext>` form per throw-away
// fixture, so a tiny in-module matcher beats pulling in minimatch for
// this handful of trivial patterns.
const SELF_CHURN = {
  // cms-publish-loop-host.yml runs FOUR specs serially:
  host: [
    ...CANARY_PATHS, //                              cms-publish-loop.spec.js
    "_e2e/canary-delete-*.md", //                    cms-delete-published.spec.js (throw-away)
    "_posts/2024-01-02-e2e-unpublish-canary.md", //  cms-unpublish-republish.spec.js
    "_tags/e2e-tags-canary-*.md", //                 cms-tags-lifecycle.spec.js (throw-away)
  ],
  // cms-media-roundtrip.yml runs cms-media-roundtrip.spec.js. Ephemeral
  // per-run post + throw-away upload, both segment-anchored prefix globs
  // (#1771 step 4): the spec CREATES + DELETES them within a run, so each
  // create/delete auto-merge to main is the loop feeding itself.
  media: [
    "_posts/2099-12-31-e2e-media-roundtrip-*.md", //         ephemeral per-run post
    "assets/images/uploads/e2e-media-roundtrip-*.png", //    throw-away upload
  ],
  // cms-publish-loop-prod.yml runs cms-publish-loop-prod-mutate.spec.js.
  // Ephemeral per-run born-published post (#1771 step 4) — the create AND
  // delete auto-merges back to main are the loop's own self-churn.
  prod: [
    "_posts/2099-12-31-e2e-prod-mutate-*.md", //             ephemeral per-run post
  ],
};

function globToRegExp(glob) {
  // Escape regex metachars (NOT `*`), then `*` → `[^/]*` so a pattern
  // can only match within a single path segment.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, "[^/]*") + "$");
}

const COMPILED = Object.fromEntries(
  Object.entries(SELF_CHURN).map(([loop, globs]) => [loop, globs.map(globToRegExp)]),
);

// Is a single repo-relative path part of `loop`'s self-churn set?
function isSelfChurn(loop, p) {
  const res = COMPILED[loop];
  if (!res) throw new Error(`Unknown loop: ${loop}`);
  return res.some((re) => re.test(p));
}

// RUN (true) iff ANY changed path falls OUTSIDE the loop's self-churn
// set. `changedPaths` MUST be a non-empty array of repo-relative paths:
// the composite handles the branch-create / unreachable-before /
// diff-error / empty-set cases by failing OPEN (run) *before* calling
// this, so this function stays pure and total for its contract.
function shouldRunLoop(loop, changedPaths) {
  if (!COMPILED[loop]) throw new Error(`Unknown loop: ${loop}`);
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    throw new Error("shouldRunLoop: changedPaths must be a non-empty array");
  }
  return changedPaths.some((p) => !isSelfChurn(loop, p));
}

module.exports = { SELF_CHURN, shouldRunLoop, isSelfChurn };
