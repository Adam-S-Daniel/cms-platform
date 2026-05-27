// @lane: real — read-only probe of the deployed preview surface
// @select-skip-when-head-ref-prefix: cms/
//
// Lightweight companion to the heavy cms-media-roundtrip loop. Where
// that spec drives the full Decap upload → publish → delete cycle
// (slow, dispatch/nightly, NON-required), THIS spec is the fast,
// read-only merge gate: it asserts that a committed image under the
// flat `media_folder` (assets/images/uploads/) actually RESOLVES on
// the PR's already-deployed preview-pr<N>.adamdaniel.ai surface —
// i.e. the exact regression class fixed in PR #952 (flattened
// media_folder / broken image + Copy Path), verified on the real
// S3+CloudFront preview build rather than only structurally
// (cms-config.spec.js) or against a local Jekyll build.
//
// No CMS, no PAT, no mutation — a single HTTP GET. Runs ONLY in the
// dedicated preview-media.yml workflow, which sets RUN_PREVIEW_MEDIA_PROBE=1
// AFTER it has polled the preview-pr<N> surface for reachability (its
// "Wait for the preview surface" step). That opt-in gate is what makes
// this a stable, required check — WITHOUT it, the spec also ran in the
// general e2e matrix (which exposes PR_NUMBER for the live-failures
// reporter, so the `!target.host` self-skip didn't fire) where there is
// NO reachability poll: it raced the per-PR preview deploy — or, on a
// PR that doesn't even trigger deploy-preview (e.g. an e2e/**-only
// change, which deploy-preview path-ignores), probed a preview that
// never exists — and 4xx-flaked the required `e2e (1)` check (#1723
// Cat 5; e.g. e2e-tests run 26474462279). Gating on the explicit
// workflow opt-in (mirrors RUN_PROD_MUTATE_PLAYGROUND / the other heavy
// real-lane specs) keeps it to the one context that guarantees a
// reachable preview first. `@select-skip-when-head-ref-prefix: cms/`
// keeps it out of Decap-opened editorial PRs (consistent with siblings).

const { test, expect } = require("./base");
const { previewTarget } = require("./cms-host");

// Only the dedicated preview-media.yml workflow opts in (after its
// bounded preview-reachability poll). Anywhere else — the general e2e
// matrix, e2e-real, local dev — this is a no-op.
const RUN_PREVIEW_MEDIA_PROBE = process.env.RUN_PREVIEW_MEDIA_PROBE === "1";

// Bounded retry for per-asset CDN propagation: the workflow's poll
// confirms the preview ROOT is 200, but CloudFront can serve the
// specific object a little later. Poll the probe URL itself (cheap HTTP
// GET) before asserting, so a few seconds of per-object propagation lag
// doesn't flake the gate — while a genuinely-broken flat media_folder
// (the PR #952 regression class) still fails loud once the budget is
// spent. ~3 min is generous next to the workflow's ~20 min root poll.
const PROBE_TOTAL_MS = 3 * 60 * 1000;
const PROBE_POLL_MS = 8000;

// 1×1 PNG committed at the flat media_folder path, so it ships with
// every Jekyll build (and therefore every preview deploy). If the
// flat media_folder regresses (a templated subfolder creeps back, or
// the CloudFront/S3 preview routing drops the prefix), this exact URL
// 404s on the deployed surface and the gate fails.
const PROBE_PATH = "/assets/images/uploads/e2e-preview-media-probe.png";

const target = previewTarget();
const PROBE_URL = target.host ? `${target.host}${PROBE_PATH}` : "";

test.describe("preview media resolves on the deployed surface", () => {
  // Opt-in gate FIRST: outside preview-media.yml (which polls preview
  // reachability before setting this), there is no guarantee a preview
  // exists, so the probe must not run — that was the #1723 Cat 5 flake.
  test.skip(
    !RUN_PREVIEW_MEDIA_PROBE,
    "RUN_PREVIEW_MEDIA_PROBE not set — only the dedicated preview-media.yml " +
      "workflow (which polls the preview surface for reachability first) runs " +
      "this probe; it is a no-op in the general e2e matrix / e2e-real / local dev (#1723 Cat 5).",
  );
  test.skip(
    !target.host,
    "No preview-pr<N> host resolvable (PR_NUMBER/GITHUB_PR_NUMBER unset) — " +
      "this gate is a no-op outside the dedicated preview-media.yml workflow.",
  );

  test("committed media_folder image returns 200 on the preview env", async ({ page }) => {
    // Bounded poll for per-object CDN propagation (the workflow already
    // confirmed the preview ROOT is live). Capture the last response so
    // the assertions below report the real terminal status/headers/body.
    const deadline = Date.now() + PROBE_TOTAL_MS;
    let res = await page.request.get(PROBE_URL, { failOnStatusCode: false });
    while (res.status() !== 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
      res = await page.request.get(PROBE_URL, { failOnStatusCode: false });
    }

    expect(
      res.status(),
      `${PROBE_URL} must serve HTTP 200 on the deployed preview (polled up to ` +
        `${Math.round(PROBE_TOTAL_MS / 1000)}s for CDN propagation). A 4xx/5xx ` +
        `that outlasts the budget means the flat media_folder path ` +
        `(assets/images/uploads/) is broken on the real S3/CloudFront preview ` +
        `build — the PR #952 regression class (broken images / Copy Path) ` +
        `reaching the deployed surface, which local-only tests cannot catch.`,
    ).toBe(200);

    const contentType = res.headers()["content-type"] || "";
    expect(
      contentType,
      `${PROBE_URL} resolved but with a non-image content-type ` +
        `(${contentType || "<none>"}) — likely an SPA/404 HTML fallback ` +
        `being served in place of the asset.`,
    ).toMatch(/^image\//i);

    const body = await res.body();
    expect(body.length, `${PROBE_URL} served a 200 with an empty body.`).toBeGreaterThan(0);
  });
});
