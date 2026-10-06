/*
 * #689 — find, remove and report e2e tag files left on a consumer's main.
 *
 * The tags lifecycle specs create `_tags/e2e-tags-canary-<runId>.md`
 * (`<runId>` = the run's Date.now()) and delete it again. A run whose create
 * PR merged after its cleanup looked left one on adamdaniel.ai's main from
 * 2026-08-06 until adamdaniel.ai#4090 removed it, live on the public site the
 * whole time. scripts/reset-orphaned-canary.sh, which runs early in every
 * main-targeting publish loop, calls sweepLeftoverE2eTags so a leftover is
 * removed on the next loop and the host loop's daily run fails (reported by
 * scheduled-run-health) instead of nobody noticing.
 *
 * What gets removed is deliberately narrow: only a run-stamped canary name
 * whose stamp is older than STALE_AFTER_MS, so a loop can never delete the
 * tag of a run still in flight (the spec's own budget is 80 min). Any other
 * `e2e-` tag file is reported but never touched.
 *
 * Logs carry paths and counts only; an error is described by status code
 * and type (describeError), never by its message or an API body, because
 * these logs are public on a public consumer.
 */
const { listAllPages } = require("./cms-fixture-pr");

const TAGS_DIR = "_tags";
const E2E_PREFIX = "e2e-";
// e2e-tags-canary-<ms> (cms-tags-lifecycle.spec.js) and
// e2e-tags-canary-preview-<ms> (cms-tags-lifecycle-preview.spec.js).
const CANARY_TAG_RE = /^e2e-tags-canary-(?:preview-)?(\d{13})\.md$/;
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
// A stamp this far past `now` was not written by a run's Date.now(): clock
// skew between runners is seconds, not minutes.
const FUTURE_SKEW_MS = 10 * 60 * 1000;

/**
 * Split a `_tags` directory listing (`{ type, name }` entries) into the e2e tag
 * files that are stale run-stamped canaries (safe to remove), fresh ones (a
 * run may still own them), future-stamped ones and any other `e2e-` file
 * (the last two are reported, never removed).
 */
function classifyE2eTags(entries, nowMs) {
  const stale = [];
  const fresh = [];
  const future = [];
  const other = [];
  for (const entry of entries) {
    if (!entry || entry.type !== "file" || typeof entry.name !== "string") continue;
    if (!entry.name.startsWith(E2E_PREFIX)) continue;
    const path = `${TAGS_DIR}/${entry.name}`;
    const m = CANARY_TAG_RE.exec(entry.name);
    if (!m) {
      other.push(path);
    } else if (Number(m[1]) - nowMs > FUTURE_SKEW_MS) {
      future.push(path);
    } else if (nowMs - Number(m[1]) > STALE_AFTER_MS) {
      stale.push(path);
    } else {
      fresh.push(path);
    }
  }
  return { stale, fresh, future, other };
}

/**
 * List the entries of `_tags` on `ref` as `{ type: "file" | "dir", name }`,
 * or null when `ref` has no `_tags` directory (or `ref` itself is absent).
 *
 * This reads the git trees API, not the Contents API: a Contents API
 * directory listing stops at 1,000 entries, so on a site with more tags a
 * leftover past that cut would read clean. A non-recursive tree has no such
 * cap; a `truncated` tree throws rather than reading partial.
 */
async function listTagsDir(ghImpl, repo, ref) {
  let root;
  try {
    root = await ghImpl(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}`, { retries: 2 });
  } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
  if (!root || !Array.isArray(root.tree)) {
    throw new TypeError(`${ref} root tree listing is not a tree`);
  }
  const dir = root.tree.find((t) => t && t.path === TAGS_DIR);
  if (!dir && root.truncated) {
    throw new Error(`${ref} root tree listing is truncated`);
  }
  if (!dir) return null;
  if (dir.type !== "tree" || typeof dir.sha !== "string") {
    throw new TypeError(`${TAGS_DIR}@${ref} listing is not a directory`);
  }
  const listing = await ghImpl(`/repos/${repo}/git/trees/${dir.sha}`, { retries: 2 });
  if (!listing || !Array.isArray(listing.tree)) {
    throw new TypeError(`${TAGS_DIR}@${ref} listing is not a tree`);
  }
  if (listing.truncated) {
    throw new Error(`${TAGS_DIR}@${ref} tree listing is truncated`);
  }
  return listing.tree.map((t) => ({
    type: t.type === "blob" ? "file" : t.type === "tree" ? "dir" : t.type,
    name: t.path,
  }));
}

/**
 * List `_tags` on `ref`, open a fire-and-forget removal PR for each stale
 * canary tag, and return what is left over.
 *
 * Returns `{ leftover, removed, fresh, future, other }` where `leftover`
 * counts the stale, future-stamped and other files (each one a defect to report, even when its removal
 * PR is already open) and `removed` lists the files this call opened a
 * removal PR for. No `_tags` directory (or a 404 on the ref's tree) means
 * nothing left over. Any other
 * listing error throws, and so does a failed removal, so the caller can
 * report "could not verify" instead of a false clean.
 */
async function sweepLeftoverE2eTags({ repo, ref = "main", ghImpl, removeImpl, nowMs, log = console.log }) {
  const entries = await listTagsDir(ghImpl, repo, ref);
  if (entries === null) {
    log(`[leftover-e2e-tags] ${TAGS_DIR}@${ref}: no ${TAGS_DIR} directory — nothing to check.`);
    return { leftover: 0, removed: [], fresh: [], future: [], other: [] };
  }
  const { stale, fresh, future, other } = classifyE2eTags(entries, nowMs);
  for (const p of fresh) {
    log(`[leftover-e2e-tags] ${p}@${ref}: younger than the stale threshold — a run may own it; left alone.`);
  }
  for (const p of future) {
    log(`[leftover-e2e-tags] ${p}@${ref}: canary stamp is in the future — reported, not removed.`);
  }
  for (const p of other) {
    log(`[leftover-e2e-tags] ${p}@${ref}: e2e tag that is not a run-stamped canary — reported, not removed.`);
  }
  const removed = [];
  // Two loops a day both reach this sweep; one open removal PR per file is
  // enough, so skip a file whose `cms/e2e-fixture/remove-<slug>-` PR is open.
  const openHeads = [];
  if (stale.length > 0) {
    const prs = await listAllPages(
      ghImpl,
      `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(ref)}`,
    );
    for (const pr of prs) {
      if (pr && pr.head && typeof pr.head.ref === "string") openHeads.push(pr.head.ref);
    }
  }
  for (const p of stale) {
    const slug = p.slice(TAGS_DIR.length + 1).replace(/\.md$/, "");
    if (openHeads.some((h) => h.startsWith(`cms/e2e-fixture/remove-${slug}-`))) {
      log(`[leftover-e2e-tags] ${p}@${ref}: stale canary tag — a removal PR is already open.`);
      continue;
    }
    log(`[leftover-e2e-tags] ${p}@${ref}: stale canary tag — opening a removal PR.`);
    await removeImpl({
      repo,
      slug,
      runId: `orphan-sweep-${nowMs}`,
      filePath: p,
      message: `test(canary): remove leftover e2e tag ${p}`,
      prTitle: `test(canary): remove leftover e2e tag ${p}`,
      prBody:
        `A tags lifecycle run left \`${p}\` on ${ref} (cms-platform#689). ` +
        "This PR, opened by the publish loop's self-heal (scripts/reset-orphaned-canary.sh), " +
        "removes it and auto-merges via `cms/ready`.",
      skipWaitForMerge: true,
    });
    removed.push(p);
  }
  return {
    leftover: stale.length + future.length + other.length,
    removed,
    fresh,
    future,
    other,
  };
}

module.exports = {
  CANARY_TAG_RE,
  STALE_AFTER_MS,
  classifyE2eTags,
  sweepLeftoverE2eTags,
};
