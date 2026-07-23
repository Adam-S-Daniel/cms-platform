/*
 * Helpers that let Playwright drive Decap CMS as an authenticated user
 * without going through the OAuth-proxy popup dance.
 *
 * Decap's GitHub backend persists its auth in localStorage under
 * `decap-cms-user` (the key was `netlify-cms-user` in early 2.x; v3
 * renamed it. Decap 3.x has zero references to the legacy key, so
 * seeding the old name silently falls through to the login screen).
 * Pre-seeding the live key makes the editor mount already-logged-in,
 * which is what we want for unattended e2e runs:
 *
 *   { backendName: "github", token: "<PAT>", login: "<user>", name: "..." }
 *
 * The PAT is read from CMS_E2E_PAT and must be a fine-grained token
 * scoped to the host repo with three repository permissions:
 *
 *   - `Contents: read/write`     — file CRUD via the Contents API
 *   - `Pull requests: read/write` — open / label / merge cms/* PRs
 *   - `Actions: read`            — read workflow run state (the test
 *                                   helpers poll workflow conclusions
 *                                   while waiting for auto-merge +
 *                                   deploy-production to finish).
 *                                   No dispatch is needed — the
 *                                   earlier shim → delete-via-pr.yml
 *                                   path was removed once we
 *                                   confirmed Decap's delete UI uses
 *                                   the git data API directly, not
 *                                   DELETE /contents.
 *
 * Used by `e2e/cms-publish-loop.spec.js` (host repo, target main) and
 * `e2e/cms-publish-loop-preview.spec.js` (preview env, target PR head)
 * and `e2e/cms-delete-published.spec.js`.
 */
// Live key as of Decap CMS 3.12.2. If a future major bump renames it
// again, the cms-publish-loop specs will get stuck on Decap's login
// screen — re-run e2e/debug-decap-auth.spec.js (or grep the bundle:
// `curl -s https://unpkg.com/decap-cms@<v>/dist/decap-cms.js |
//  grep -oE '"[a-z-]*[-._]user[a-z._-]*"' | sort -u`) to find the
// new key.
const DECAP_CMS_USER_KEY = "decap-cms-user";

// Legacy alias retained so an old reference in archived code doesn't
// break imports. Will be removed in a follow-up cleanup.
const NETLIFY_CMS_USER_KEY = DECAP_CMS_USER_KEY;

// The host-repo publish/delete/unpublish/tags-lifecycle specs (and every
// helper that defaults `repo = HOST_REPO` — cms-fixture-pr.js,
// github-actions-poll.js, reset-orphaned-canary.sh) target whatever repo
// the loop is actually running against. The loop workflows all export
// `CMS_REPO: ${{ github.repository }}` (see cms-publish-loop-host.yml and
// its siblings) specifically so this constant can resolve per-consumer;
// GITHUB_REPOSITORY is GitHub Actions' own ambient fallback for the same
// value. The literal is the local-dev fallback (no env, e.g. running a
// spec by hand outside CI) — it preserves the historical adamdaniel.ai
// behavior byte-for-byte. Before this was env-derived, the hardcoded
// literal cross-wired EVERY OTHER consumer's host loop into
// Adam-S-Daniel/adamdaniel.ai regardless of which repo the workflow ran
// in, which is what caused the jodidaniel.com host loop's cross-repo 403s
// (issue #185).
const HOST_REPO = process.env.CMS_REPO || process.env.GITHUB_REPOSITORY || "Adam-S-Daniel/adamdaniel.ai";

function getPat() {
  return process.env.CMS_E2E_PAT || "";
}

function getLogin() {
  return process.env.CMS_E2E_USER || "Adam-S-Daniel";
}

function buildAuthRecord(token, login) {
  return {
    backendName: "github",
    token,
    login,
    name: "E2E Test Harness",
  };
}

/**
 * Seed `localStorage[netlify-cms-user]` so Decap sees an existing GitHub
 * session and skips the OAuth popup. Run before `page.goto("/admin/")`.
 *
 * Throws synchronously if CMS_E2E_PAT isn't set — the publish-loop tests
 * are gated to the host repo, so a missing token is a setup error, not
 * a soft skip.
 */
async function seedDecapAuth(page, { token = getPat(), login = getLogin() } = {}) {
  if (!token) {
    throw new Error(
      "CMS_E2E_PAT env var is empty. The CMS publish-loop test needs a fine-grained PAT in repo secrets. See AGENTS.md.",
    );
  }
  const record = buildAuthRecord(token, login);
  await page.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {
        /* private mode etc — let Decap surface the resulting error */
      }
    },
    { key: DECAP_CMS_USER_KEY, value: record },
  );
}

module.exports = {
  HOST_REPO,
  DECAP_CMS_USER_KEY,
  NETLIFY_CMS_USER_KEY,
  buildAuthRecord,
  getLogin,
  getPat,
  seedDecapAuth,
};
