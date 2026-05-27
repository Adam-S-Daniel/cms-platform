// @lane: real — drives the real Decap delete UI end-to-end in a PR preview env
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — PR_NUMBER / PR_HEAD_REF / CMS_E2E_PAT aren't wired into the
// standard PR matrix — so selecting + bringing it up just to no-op is
// pure waste. The dedicated cms-delete-published-preview workflow
// exercises this path.

/*
 * Preview-side "Delete published entry" coverage. The prod sibling
 * `cms-delete-published.spec.js` proves the delete path lands on
 * `main`; this proves it on a per-PR preview environment
 * (`preview-pr<N>.adamdaniel.ai/admin/`) whose admin is patched at
 * deploy-preview time to use `backend.branch = <PR head ref>`. That's
 * a different code path (and a different branch-protection regime —
 * the `cms-feature-branches` ruleset, not main) and closes the
 * preview-side entry-deletion gap from #999's matrix.
 *
 * Both legs go through the shared `runCmsLoop` spine
 * (`e2e/run-cms-loop.js`) — the first opt-in consumer of the extracted
 * helper. No back doors: every product step (create, publish, delete)
 * is UI-driven per AGENTS.md "Never bypass the UI in a UI test." The
 * Contents-API afterAll is harness HYGIENE only (not the behaviour
 * under test) and writes ONLY to the PR head branch, so a stale
 * fixture has zero prod blast radius — it dies with the PR.
 *
 * Fixture model (mirrors the prod delete spec): the spec creates and
 * then deletes its own throw-away `_e2e/canary-delete-preview-<runId>.md`.
 * A crash mid-flow leaves a recognisable, dated stub on the PR head
 * branch (swept by the same `canary-delete-*` prefix the daily sweep
 * already recognises, and by this spec's afterAll), never a damaged
 * checked-in fixture.
 *
 *   - Seed: "+ New E2E Canary" → fill Title + Body → Save → the
 *     `cms/e2e/<slug>` PR Decap opens against the PR head branch →
 *     label `cms/ready` → cms-editorial-workflow auto-merges into the
 *     head branch → deploy-preview re-renders → the preview URL 200s
 *     with the body marker.
 *   - Delete: navigate to the just-created entry → "Delete published
 *     entry" → confirm (persistent native-dialog handler) → Decap
 *     commits the delete to the head branch (best-effort label of a
 *     delete PR if Decap opened one) → deploy-preview → the preview
 *     URL 404s.
 *
 * Gating:
 *   - CMS_E2E_PAT must be set.
 *   - PR_NUMBER must be set (the workflow exposes it from its input).
 *   - PR_HEAD_REF must be set (resolved from the PR via the API).
 *   - Runs once on chromium-desktop-3k only.
 */
const { test, expect } = require("./base");
const { getPat, HOST_REPO } = require("./decap-pat");
const { addLabel, gh } = require("./github-actions-poll");
const { previewTarget } = require("./cms-host");
const { runCmsLoop } = require("./run-cms-loop");

// Host triplet resolves through the shared cms-host resolver. `host`
// is "" when no PR number is resolvable — the spec test.skip's on
// `!PR_NUMBER` before any PREVIEW_* value is used (same self-skip
// guard cms-publish-loop-preview.spec.js relies on).
const {
  host: PREVIEW_HOST,
  adminUrl: PREVIEW_ADMIN,
  pillId: PILL_PREVIEW,
  prNumber: PR_NUMBER,
} = previewTarget();
// PR_HEAD_REF is ONLY honoured when a workflow sets it explicitly (the
// dedicated cms-delete-published-preview.yml does). The previous
// `|| process.env.GITHUB_HEAD_REF` fallback was the loop bug: GitHub
// auto-populates GITHUB_HEAD_REF on every `pull_request` event, so this
// @admin-write spec passed its PR_HEAD_REF gate inside e2e-tests.yml's
// e2e-admin lane (which sets CMS_E2E_PAT + PR_NUMBER) on any PR. It then
// drove Decap to open a cms/e2e/<slug> PR against the PR head branch,
// editorial-workflow auto-merged it, the push re-fired pull_request:
// synchronize, and e2e-admin ran the spec again — an unbounded loop.
const PR_HEAD_REF = process.env.PR_HEAD_REF || "";

// Stable, checked-in canary entry present on every branch — used as a
// deterministic pill-mount point for the URL waits (deploy-status-pill.js
// only injects into an entry editor's toolbar; the new-entry form and
// the post-delete collection list have no pill). Mirrors
// cms-delete-published.spec.js's "navigate to canary-page" step.
const PILL_MOUNT_SLUG = "canary-page";

// Two editorial-workflow auto-merge cycles end to end (seed publish +
// delete) plus two deploy-preview waits and the in-browser drive of
// both. deploy-preview is lighter than deploy-production but the
// editorial-workflow + required-check matrix on the head branch is the
// same shape; 30 min covers a busy-runner day. Retries disabled — this
// mutates real PR-branch state, so a retry just re-walks the same
// broken chain (matches every sibling loop spec).
const TEST_TIMEOUT_MS = 30 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Module-scoped handle so the afterAll safety-net can see the
// slug/filePath generated inside the test. The delete leg IS the
// cleanup; if it succeeds the file is gone from the head branch and
// the harness no-ops. If the test threw mid-flow, the harness removes
// the throw-away fixture from the head branch so the next run starts
// clean.
let pendingFixture = null;

async function fileShaOnBranch(filePath, branch) {
  try {
    const res = await gh(
      `/repos/${HOST_REPO}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
    );
    return res.sha;
  } catch (e) {
    if (e && (e.status === 404 || /\b404\b/.test(String(e.message)))) {
      return null;
    }
    throw e;
  }
}

// Best-effort: delete the throw-away fixture directly on the PR head
// branch via the Contents API. Harness hygiene only — never part of
// the behaviour under test (the delete leg deletes via the Decap UI).
// Writing to the head branch is allowed for the owner PAT (same path
// cms-publish-loop-preview.spec.js uses to reset its canary) and has
// zero prod blast radius: the branch is deleted when the parent PR
// merges or closes.
async function deleteFixtureFromHeadBranch(filePath, branch, message) {
  const sha = await fileShaOnBranch(filePath, branch);
  if (!sha) return false;
  await gh(`/repos/${HOST_REPO}/contents/${filePath}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch }),
  });
  return true;
}

test(
  "Delete published entry — preview env, target PR head branch → preview URL 404s",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — preview delete-published spec disabled.");
    test.skip(
      !PR_NUMBER || !PR_HEAD_REF,
      "PR_NUMBER / PR_HEAD_REF not set — this spec only runs in the dedicated preview workflow.",
    );

    // PERSISTENT dialog handler — Decap's "Delete published entry" path
    // raises a native confirm(). Playwright auto-DISMISSES dialogs with
    // no listener, which Decap reads as "user cancelled" and aborts the
    // delete. Register BEFORE any interaction so every dialog any flow
    // raises is accepted (mirrors cms-delete-published.spec.js).
    page.on("dialog", (d) => d.accept());

    // Lightweight GitHub-API trace — the diagnostic surface a future
    // failure points at (mirrors the prod delete spec).
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.info(`[trace] console.${t}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.warn(`[trace] pageerror: ${err && err.message}`);
    });

    // Title shape is plain ASCII letters/digits/spaces so Decap's
    // default slugify (lowercase, non-alphanumerics → `-`) yields a
    // slug we can predict client-side: "Canary delete preview <id>"
    // → "canary-delete-preview-<id>". Keep this ASCII-only or the
    // derived slug won't match and the URL assertions break.
    const runId = Date.now();
    const slug = `canary-delete-preview-${runId}`;
    const filePath = `_e2e/${slug}.md`;
    const title = `Canary delete preview ${runId}`;
    // Unique body string — appears verbatim in the new file's PR diff,
    // so it disambiguates this run's `cms/e2e/<slug>` PR from any
    // stale one (waitForCmsPullRequest matches on the patch text).
    const bodyMarker = `e2e-delete-preview:${runId}`;
    const bodyText =
      `${bodyMarker}\n\n` +
      `Throw-away fixture from run ${runId}. Used by ` +
      `cms-delete-published-preview.spec.js to exercise the preview-env ` +
      `editorial-workflow delete path. Safe to delete.`;
    const publicUrl = `${PREVIEW_HOST}/e2e/${slug}/`;
    pendingFixture = { slug, filePath, runId };

    test.info().annotations.push({
      type: "fixture-path",
      description: `${filePath} @ ${PR_HEAD_REF}`,
    });

    // ── 0. Confirm clean pre-state ─────────────────────────────────
    // The slug is per-run unique, so the preview URL must 404 before
    // we drive the admin. A 200 here means a prior run's fixture
    // collided (impossible with Date.now()) or the assertion target
    // is wrong — fail fast rather than "pass" on stale content.
    await test.step("Confirm the preview URL 404s before driving admin", async () => {
      const res = await page.request.get(publicUrl, {
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(res.status(), `${publicUrl} must not exist yet (unique per-run slug)`).toBe(404);
    });

    // ── 1. SEED leg — create + publish the throw-away canary ───────
    // Shared spine: seed auth → "+ New E2E Canary" form → fill
    // Title+Body → Save → "Changes saved" → cms/e2e/<slug> PR against
    // the PR head branch → label cms/ready (editorial-workflow
    // auto-merges into the head branch, exactly like
    // cms-publish-loop-preview.spec.js) → deploy-preview → URL 200s
    // with the body marker.
    await runCmsLoop(page, {
      target: { adminUrl: PREVIEW_ADMIN, pillId: PILL_PREVIEW },
      prNumber: PR_NUMBER,
      seedAuth: true,
      openEntry: async (p) => {
        await p.goto(`${PREVIEW_ADMIN}#/collections/e2e/new`, {
          waitUntil: "domcontentloaded",
        });
        await expect(p.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
          timeout: 30_000,
        });
      },
      mutate: async (p) => {
        await p.getByRole("textbox", { name: /^Title$/i }).fill(title);
        // `widget: text` plain textarea (admin/config.yml e2e
        // collection body). The `:visible` filter is required on the
        // NEW-entry form — it renders an extra hidden clipboard
        // textarea (tabindex=-1 aria-hidden) that an unqualified
        // `.last()` would pick up. Same rationale as
        // cms-delete-published.spec.js's "Fill Title and Body".
        const body = p.locator("textarea:visible").last();
        await body.click();
        await body.pressSequentially(bodyText);
      },
      save: true,
      base: PR_HEAD_REF,
      filePath,
      canaryMarker: bodyMarker,
      prTimeoutMs: 5 * 60 * 1000,
      ready: "label",
      beforeReflect: async (p) => {
        // Move to a stable, always-present entry editor so the
        // deploy-status pill has a mount point while the auto-merge →
        // deploy-preview chain runs in the background.
        await p.goto(`${PREVIEW_ADMIN}#/collections/e2e/entries/${PILL_MOUNT_SLUG}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(p.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
          timeout: 60_000,
        });
      },
      assertReflected: async () => {
        const res = await page.request.get(publicUrl, {
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        if (res.status() !== 200) return false;
        return (await res.text()).includes(bodyMarker);
      },
      urlTimeoutMs: 12 * 60 * 1000,
    });

    // ── 2. DELETE leg — UI-delete the entry, assert the URL 404s ───
    // Shared spine with `save:false` (the delete click IS the
    // mutation) and `ready:'none'` (Decap commits the delete ref
    // directly via the git data API — same contract the prod delete
    // spec relies on). `beforeReflect` does the version-agnostic
    // best-effort label (handles the case where Decap opens a delete
    // PR against the head branch instead of committing directly —
    // mirrors cms-media-roundtrip.spec.js) and re-mounts the pill.
    await runCmsLoop(page, {
      target: { adminUrl: PREVIEW_ADMIN, pillId: PILL_PREVIEW },
      prNumber: PR_NUMBER,
      seedAuth: false,
      openEntry: async (p) => {
        await p.goto(`${PREVIEW_ADMIN}#/collections/e2e/entries/${slug}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(p.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
          timeout: 30_000,
        });
      },
      mutate: async (p) => {
        // Decap renders delete either as a top-level button or behind
        // the entry-status menu, depending on editorial state. Try the
        // direct button, fall back to the status menu. Pin a timeout on
        // every action so a UI-shape change fails in ~30s, not at the
        // outer test timeout. Mirrors cms-delete-published.spec.js
        // step 4 exactly.
        const trigger = p.getByRole("button", { name: /delete (published )?entry/i }).first();
        if (await trigger.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await trigger.click({ timeout: 30_000 });
        } else {
          await p
            .getByRole("button", {
              name: /^(Status:|Published$|In Review$|Ready$|Draft$)/i,
            })
            .first()
            .click({ timeout: 30_000 });
          await p
            .getByRole("menuitem", {
              name: /delete (published )?entry/i,
            })
            .first()
            .click({ timeout: 30_000 });
        }
        // Native confirm() is handled by the persistent dialog
        // listener registered at the top of the test. If Decap used
        // an in-page modal instead, click its confirm button.
        const confirmInPageModal = p.getByRole("button", {
          name: /^(delete|confirm|yes|ok)$/i,
        });
        await confirmInPageModal
          .first()
          .click({ timeout: 5_000 })
          .catch((err) => {
            console.debug(
              "[cms-delete-published-preview] no in-page confirm button " +
                "(Decap likely used native confirm() — handled by the " +
                "persistent dialog listener):",
              err && err.message,
            );
          });
      },
      save: false,
      ready: "none",
      beforeReflect: async (p) => {
        // Decap's GitHub backend may commit the delete straight to the
        // head branch OR open a cms/* PR (version-dependent). Don't
        // assume — if a cms/* PR removing this file appears, label it
        // cms/ready so editorial-workflow auto-merges it; otherwise
        // the direct commit already triggered deploy-preview. Either
        // way the ground truth is the URL going 404. Mirrors
        // cms-media-roundtrip.spec.js step 11.
        const deadline = Date.now() + 90_000;
        let labelled = false;
        while (Date.now() < deadline && !labelled) {
          let prs = [];
          try {
            prs = await gh(
              `/repos/${HOST_REPO}/pulls?state=open&base=${encodeURIComponent(
                PR_HEAD_REF,
              )}&per_page=50`,
            );
          } catch (e) {
            console.warn(
              `[cms-delete-published-preview] transient pulls list error: ${e && e.message}`,
            );
          }
          const cmsPrs = (prs || []).filter(
            (pr) => pr.head && typeof pr.head.ref === "string" && pr.head.ref.startsWith("cms/"),
          );
          for (const pr of cmsPrs) {
            let files;
            try {
              files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
            } catch (e) {
              console.warn(
                `[cms-delete-published-preview] could not read PR #${pr.number} files: ${
                  e && e.message
                }`,
              );
              continue;
            }
            const removesFixture = files.some(
              (f) => f.filename === filePath && f.status === "removed",
            );
            if (removesFixture) {
              try {
                await addLabel({
                  prNumber: pr.number,
                  label: "cms/ready",
                });
                console.info(
                  `[cms-delete-published-preview] labelled delete PR #${pr.number} cms/ready`,
                );
              } catch (e) {
                console.warn(
                  `[cms-delete-published-preview] could not label PR #${pr.number}: ${
                    e && e.message
                  }`,
                );
              }
              labelled = true;
              break;
            }
          }
          if (!labelled) {
            await new Promise((r) => setTimeout(r, 6000));
          }
        }
        // Re-mount the pill on a stable entry editor (the deleted
        // entry's editor unmounts; the collection list has no pill).
        await p.goto(`${PREVIEW_ADMIN}#/collections/e2e/entries/${PILL_MOUNT_SLUG}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(p.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
          timeout: 60_000,
        });
      },
      assertReflected: async () => {
        const res = await page.request.get(publicUrl, {
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        const status = res.status();
        return status >= 400 && status < 500;
      },
      urlTimeoutMs: 12 * 60 * 1000,
    });

    // ── 3. Final ground-truth assertion ────────────────────────────
    // The urlCheck above is the gate; this is a clearer error if
    // something raced past it.
    await test.step("Confirm the preview URL 404s (final)", async () => {
      const res = await page.request.get(publicUrl, {
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      const status = res.status();
      if (status < 400 || status >= 500) {
        throw new Error(
          `${publicUrl} returned ${status} — expected 4xx after the UI delete + deploy-preview.`,
        );
      }
    });
  },
);

// ── Test-harness cleanup safety net ───────────────────────────────
//
// The delete leg IS the cleanup (the UI delete removes the file from
// the PR head branch). If the test body completed, the file is gone
// and `fileShaOnBranch` returns null — harness no-ops. If the test
// failed mid-flow (chain stuck, Decap regression, etc.) the throw-away
// fixture is still on the head branch; remove it directly via the
// Contents API so the next run starts clean. Writing to the head
// branch has zero prod blast radius — the branch is deleted with the
// parent PR. Per AGENTS.md this API path is restricted to harness
// hygiene and never replaces the UI-driven delete.
test.afterAll(async () => {
  if (!pendingFixture) return; // test never ran (skipped)
  if (!getPat()) return; // PAT-less runs can't write anyway
  if (!PR_HEAD_REF) return;
  const { filePath, slug, runId } = pendingFixture;
  let sha;
  try {
    sha = await fileShaOnBranch(filePath, PR_HEAD_REF);
  } catch (e) {
    console.warn(
      `[cleanup-harness] couldn't read ${filePath} from ${PR_HEAD_REF}; skipping safety net: ${
        e && e.message
      }`,
    );
    return;
  }
  if (!sha) {
    console.log(
      `[cleanup-harness] ${filePath} gone from ${PR_HEAD_REF}; UI delete succeeded — no safety net needed`,
    );
    return;
  }
  console.warn(
    `[cleanup-harness] ${filePath} still on ${PR_HEAD_REF} after the test; removing via Contents API (run ${runId})`,
  );
  try {
    await deleteFixtureFromHeadBranch(
      filePath,
      PR_HEAD_REF,
      `test(canary): harness safety-net delete of throw-away preview fixture ${slug} (run ${runId})`,
    );
    console.warn(`[cleanup-harness] removed ${filePath} from ${PR_HEAD_REF}`);
  } catch (e) {
    console.warn(
      `[cleanup-harness] could not remove ${filePath} from ${PR_HEAD_REF}: ${e && e.message}`,
    );
  }
});
