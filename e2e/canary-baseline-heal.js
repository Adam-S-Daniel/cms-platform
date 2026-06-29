// @lane: local — pure decision helper for the unpublish-canary self-heal
// (no browser, no network). The page/gh side-effects live in
// e2e/cms-unpublish-republish.spec.js; this module is the unit-testable core
// so the heal decision is exercised by canary-baseline-heal.test.js.

/**
 * Pure decision: given the three "canary is dirty" signals, decide what the
 * self-heal must do before the unpublish/re-publish run.
 *
 * The throw-away canary baseline is: NOT published on main, NO lingering
 * editorial PR, and the public URL hidden (4xx). Any of those three being
 * "dirty" means a prior failed run (or a fire-and-forget afterAll reset that
 * never landed) left state behind.
 *
 * @param {object} sig
 * @param {boolean} sig.mainPublished — the fixture on main reads `published: true`.
 * @param {boolean} sig.lingeringPR  — an open `cms/posts/<slug>` PR exists.
 * @param {boolean} sig.urlServes    — the public URL currently serves 200.
 * @returns {{atBaseline:boolean, needClosePr:boolean, needSeed:boolean, needUrlWait:boolean}}
 */
function computeBaselineHeal({ mainPublished, lingeringPR, urlServes }) {
  const atBaseline = !mainPublished && !lingeringPR && !urlServes;
  return {
    atBaseline,
    // Always clear a stale branch/PR when anything is dirty so the unpublish
    // leg later opens a FRESH cms/posts/<slug> PR.
    needClosePr: !atBaseline,
    // Only flip main back to published:false when it's actually published:true
    // (a stale-CDN-only dirty state needs no main write).
    needSeed: !atBaseline && mainPublished,
    // Wait for the deploy to hide the URL whenever main was published OR the
    // URL is still serving.
    needUrlWait: !atBaseline && (mainPublished || urlServes),
  };
}

module.exports = { computeBaselineHeal };
