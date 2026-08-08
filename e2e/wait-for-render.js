/*
 * Bounded "has this page finished rendering?" wait for the visual-regression
 * video pipeline's two screenshot capture sites (e2e/regression-video.spec.js).
 *
 * THE BUG (adamdaniel.ai PR #2994): that spec screenshots each changed page
 * TWICE — once served locally (a `jekyll build` on the runner) and once served
 * over the network from PROD_BASE (CloudFront) — and pixel-diffs the two. Any
 * page whose visible content is built by client-side JS on load can be
 * captured MID-RENDER: localhost paints almost instantly, a CloudFront round
 * trip does not, so the two captures can land on opposite sides of the JS
 * paint, with PROD systematically the slow side. PR #2994 was a pins-only
 * platform bump that changed ZERO files under theme/ — rendering could not
 * have changed — yet it reported `/blog/introducing-gha-bench/` (the site's
 * only page with a JS-built html-embed widget) as visually different: the
 * video showed the widget's table present on the PR side and MISSING on the
 * prod side. The page was healthy in production the whole time; it was purely
 * a capture-timing artifact.
 *
 * THE FIX is generic render-settledness, not a per-widget contract: wait for
 * the network to go idle, then wait for the DOM to stop mutating for a short
 * quiet period. No `data-*` "I am rendered" opt-in — no current widget emits
 * one, and a page-agnostic pipeline that screenshots arbitrary pages can't
 * require widgets to cooperate.
 *
 * MUST be called at BOTH capture sites — the prod-side goto AND the PR-side
 * goto. Prod is the slow side that actually needs the wait, but a future
 * editor who notices that and "simplifies" this to one call site would bring
 * the exact asymmetry PR #2994 exposed right back: the point is that BOTH
 * captures settle before either is screenshotted, so neither can win a race
 * the other loses.
 *
 * Bounded and NON-FATAL by construction: every wait here has an upper bound
 * and never throws. A page that never settles (a polling widget, a stalled
 * prod round trip) just falls back to today's un-settled screenshot — it must
 * never fail the visual-regression job, which gates a required check.
 */

// Bound on the initial "let the network go quiet" wait. Generous relative to
// a normal page load; a page that is still fetching after this long is not
// going to finish before the job needs its screenshot anyway.
const NETWORK_IDLE_TIMEOUT_MS = 8_000;

// How long the DOM must go without a mutation before we call it settled.
const QUIET_PERIOD_MS = 400;

// Upper bound on the whole DOM-quiescence wait, regardless of how often the
// quiet timer keeps getting reset by fresh mutations.
const QUIESCENCE_TIMEOUT_MS = 5_000;

// The quiet period must be reachable inside the overall bound, or the
// mutation observer could never report "quiet" before its own wait gives up
// and the quiescence leg would time out on every single page.
if (QUIET_PERIOD_MS >= QUIESCENCE_TIMEOUT_MS) {
  throw new Error(
    `[wait-for-render] QUIET_PERIOD_MS (${QUIET_PERIOD_MS}) must be smaller than ` +
      `QUIESCENCE_TIMEOUT_MS (${QUIESCENCE_TIMEOUT_MS}), or the quiet window is unreachable`,
  );
}

// Wait for `page` to look settled before it is screenshotted: network idle,
// then no DOM mutations for QUIET_PERIOD_MS. Page-agnostic — no selectors, no
// widget cooperation required. `log` defaults to console.warn so a stalled
// wait is visible in CI output without failing the job; every branch below is
// caught, so this function itself never throws.
async function waitForRenderSettled(page, log = (msg) => console.warn(msg)) {
  await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch((e) =>
      log(`[wait-for-render] networkidle timed out (${e.message}) — capturing anyway`),
    );

  await page
    .evaluate(
      ({ quietMs, boundMs }) =>
        new Promise((resolve) => {
          let timer = setTimeout(resolve, quietMs);
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(resolve, quietMs);
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          // The overall bound: fires regardless of how often mutations keep
          // resetting the quiet timer above, so a page that never stops
          // mutating (a ticking clock widget, a polling script) still
          // resolves instead of hanging this evaluate indefinitely.
          setTimeout(() => {
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          }, boundMs);
        }),
      { quietMs: QUIET_PERIOD_MS, boundMs: QUIESCENCE_TIMEOUT_MS },
    )
    .catch((e) =>
      log(`[wait-for-render] DOM-quiescence wait failed (${e.message}) — capturing anyway`),
    );
}

module.exports = {
  waitForRenderSettled,
  NETWORK_IDLE_TIMEOUT_MS,
  QUIET_PERIOD_MS,
  QUIESCENCE_TIMEOUT_MS,
};
