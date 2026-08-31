/*
 * admin/entry-status-model.js — ONE vocabulary for "is this on the website?".
 *
 * ── Why this file exists ───────────────────────────────────────────────
 * An editor on these sites currently meets NINE overlapping notions of
 * "published" across four systems, in three different vocabularies for the
 * same three states (docs/PUBLISHING-UX.md §2.9):
 *
 *   editor toolbar   Draft / In review / Ready
 *   workflow board   Drafts / In Review / Ready
 *   Decap core       Draft / Waiting for Review / Waiting to go live
 *   posts-list pill  Published / Draft / Scheduled   ← a different axis entirely
 *
 * This module is the single derivation every admin surface reads from, so
 * the collection list, the editor bar and the toolbar pill cannot drift into
 * saying different things about the same entry.
 *
 * ── The model (docs/PUBLISHING-UX.md §3.1) ─────────────────────────────
 * FOUR badges, exactly one of which applies at a time:
 *
 *   live            On the public site right now.
 *   draft           Saved, not on the site. Only you can see this.
 *   going-live      Publish requested, in flight.
 *   needs-attention Something stopped it.
 *
 * plus TWO modifiers, which sit ALONGSIDE the badge and are never folded
 * into it, because they are the editor's own choice rather than the
 * system's state:
 *
 *   hidden          `published: false` in the entry's front matter.
 *   scheduled       a future `publish_date`.
 *
 * Keeping those two out of the badge is the whole point of the split. "Live"
 * and "Hidden" are simultaneously true for an entry that is merged, deployed
 * and rendering nowhere — the §2.6 trap, where "Published" the toggle and
 * "Publish" the button differ by one letter and sit a screen apart. Merging
 * them into one word is what made that unreadable.
 *
 * ── Two additions from #371, both about not spinning forever ───────────
 * 1. THE STALL. `armed` meant "queued to merge itself", and the going-live
 *    branch believed it indefinitely — so every failure of the merge
 *    machinery rendered as "Going live…" for as long as the tab stayed open.
 *    publish-progress.js now reports `settledSince`: when the PR first had
 *    NOTHING LEFT TO WAIT FOR (armed, every check complete, nothing red, no
 *    conflict, no review-gate park) while still being open. Past
 *    STALL_GRACE_MIN of that, the honest badge is Needs attention, because a
 *    merge that was going to happen on its own had everything it needed and
 *    did not happen. The grace exists because native auto-merge fires a
 *    moment after the last check completes, and calling that a stall would
 *    be the mirror-image lie.
 *
 * 2. THE DESTINATION. A PR-preview admin edits a feature branch, not the
 *    live site — `scripts/patch-preview-config.sh` rewrites the preview
 *    admin's `backend.branch` on purpose, and cms-editorial-workflow.yml
 *    then labels the PR `cms/preview-only`, whose own description reads
 *    "drop this content from the parent branch when it merges to main". So
 *    on that surface every sentence containing "the website" was false.
 *    §2.8 measured the only thing distinguishing that admin from the real
 *    one as a 0.65rem pill in a corner; this puts it in the sentence the
 *    editor is already reading, where it cannot be missed.
 *
 * ── Deliberately pure ──────────────────────────────────────────────────
 * No DOM, no network, no clock of its own — `now` is a parameter. That is
 * what lets e2e/entry-status-model.test.js exercise every branch in a Node
 * vm sandbox with no browser and no fixed wall-clock dependency (the house
 * rule: tests must be deterministic, no reliance on wall-clock time). The
 * facts it consumes are gathered by publish-progress.js, which owns all the
 * polling.
 *
 * Exposed as `window.CMSEntryStatus`; the assignment is the only thing that
 * runs on load, mirroring live-url-derive.js and
 * oauth-app-restriction-detector.js.
 */
(function () {
  "use strict";

  var BADGE = {
    LIVE: "live",
    DRAFT: "draft",
    GOING_LIVE: "going-live",
    NEEDS_ATTENTION: "needs-attention",
  };

  // Nominal durations for the ETA. Both are measured properties of this
  // platform's chain, not guesses: the six required checks run ~5-15 min
  // (docs/CI-INVARIANTS.md), and deploy-production is ~1-2 min after the
  // merge. CHECKS_NOMINAL_MIN sits at the low-middle of that range on
  // purpose — an ETA that runs out and keeps counting reads as broken, so
  // `remainingMinutes` floors at 1 and the copy says "about", never a
  // countdown to zero.
  var CHECKS_NOMINAL_MIN = 12;
  var DEPLOY_NOMINAL_MIN = 2;
  var MS_PER_MIN = 60 * 1000;
  // How long "nothing left to wait for, still not merged" has to hold before
  // it is a stall rather than the ordinary few seconds between the last check
  // completing and native auto-merge firing. Generous on purpose: reporting a
  // healthy publish as stopped is the same class of lie as reporting a stopped
  // one as in flight, and this module's whole job is to tell neither.
  var STALL_GRACE_MIN = 3;

  // The two modifier words, exported so the collection list and the editor
  // bar cannot drift into two spellings of the same thing — which is the
  // §2.9 defect this whole module exists to end. posts-list-enhance.js reads
  // these rather than repeating the strings.
  var MODIFIER_LABELS = { hidden: "Hidden", scheduled: "Scheduled" };

  // The same four states, in the two-or-three words a list row has space
  // for. `derive().label` is the sentence form the editor bar renders; this
  // is the chip form the collection list renders. Two renderings, ONE
  // vocabulary — a list that said "Published" while the editor said "Live"
  // would be §2.9 all over again.
  var SHORT_LABELS = {};
  SHORT_LABELS[BADGE.LIVE] = "Live";
  SHORT_LABELS[BADGE.DRAFT] = "Draft";
  SHORT_LABELS[BADGE.GOING_LIVE] = "Going live…";
  SHORT_LABELS[BADGE.NEEDS_ATTENTION] = "Needs attention";

  // One palette, shared by the bar's background and the list chip's fill.
  var BADGE_COLORS = {};
  BADGE_COLORS[BADGE.LIVE] = "#1a7f37";
  BADGE_COLORS[BADGE.DRAFT] = "#57606a";
  BADGE_COLORS[BADGE.GOING_LIVE] = "#0969da";
  BADGE_COLORS[BADGE.NEEDS_ATTENTION] = "#cf222e";

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  // Minutes elapsed since `startedAt` (ms epoch), or null when unknown.
  function elapsedMinutes(startedAt, now) {
    if (!isFiniteNumber(startedAt) || !isFiniteNumber(now)) return null;
    if (now < startedAt) return 0;
    return (now - startedAt) / MS_PER_MIN;
  }

  // How much longer, in whole minutes, or null when we genuinely cannot
  // tell. Returning null is REQUIRED behaviour, not a gap: the caller
  // renders the honest "about 5-15 minutes" range in that case, and a made-up
  // number here would be the §2.4 defect in a new costume.
  function remainingMinutes(facts, now) {
    var f = facts || {};
    var nominal = f.merged ? DEPLOY_NOMINAL_MIN : CHECKS_NOMINAL_MIN;
    var elapsed = elapsedMinutes(f.startedAt, now);
    if (elapsed === null) return null;
    return Math.max(1, Math.round(nominal - elapsed));
  }

  // ── Modifiers ─────────────────────────────────────────────────────────
  // `published === false` is Hidden. `undefined` is NOT hidden: collections
  // without a `published` field (jodidaniel.com's nine section collections,
  // every file collection) must not acquire a modifier they have no control
  // over.
  function modifiersFor(facts, now) {
    var f = facts || {};
    var out = [];
    if (f.published === false) {
      out.push({
        key: "hidden",
        label: MODIFIER_LABELS.hidden,
        detail:
          "You have this switched off, so it will not show on the website even " +
          "once it is live. Turn “Published” on to show it.",
      });
    }
    var when = parseDate(f.publishDate);
    if (when !== null && isFiniteNumber(now) && when > now) {
      out.push({
        key: "scheduled",
        label: MODIFIER_LABELS.scheduled + " for " + formatDate(when),
        detail: "This appears on the website automatically on " + formatDate(when) + ".",
      });
    }
    return out;
  }

  // Tolerant of the three shapes Decap writes: an ISO datetime, a bare
  // YYYY-MM-DD, and the empty string that means "unset". Anything
  // unparseable is treated as unset — never as an epoch-0 date, which would
  // silently read as "scheduled in the past" and drop the modifier for the
  // wrong reason.
  function parseDate(value) {
    if (value === null || value === undefined) return null;
    var s = String(value).trim();
    if (!s) return null;
    var ms = Date.parse(s);
    return isFiniteNumber(ms) && !isNaN(ms) ? ms : null;
  }

  function formatDate(ms) {
    try {
      return new Date(ms).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  // ── The stall ─────────────────────────────────────────────────────────
  // Pure and clock-free: `settledSince` is gathered by publish-progress.js,
  // `now` is the caller's. With either unknown this is false — an unknown
  // must never manufacture a failure report.
  function isStalled(facts, now) {
    var f = facts || {};
    if (!isFiniteNumber(f.settledSince) || !isFiniteNumber(now)) return false;
    return now - f.settledSince >= STALL_GRACE_MIN * MS_PER_MIN;
  }

  // ── Where this entry is actually going ────────────────────────────────
  // "the website" is a lie on a preview surface (see the header). Naming the
  // branch rather than inventing a preview URL follows publish-button.js's
  // targetUrl() rule: naming the wrong URL would be worse than naming none.
  function destination(facts) {
    var f = facts || {};
    if (!f.previewOnly) return { noun: "the website", preview: false };
    return {
      noun: "the preview for " + (f.baseRef ? "“" + f.baseRef + "”" : "this branch"),
      preview: true,
    };
  }

  // ── Needs-attention copy ──────────────────────────────────────────────
  // Every branch names ONE thing a non-technical person can actually do.
  // A raw Actions URL is not an action for this audience (§4 phase 4), so
  // the contact is named instead; `contact` comes from the site's own
  // window.CMS_SUPPORT_CONTACT, falling back to a generic noun rather than
  // to a broken link.
  function attentionCopy(facts, contact, stalled) {
    var f = facts || {};
    var who = contact || "whoever looks after this website";
    // Ordered before the generic fallback but AFTER every specific cause: a
    // PR is only ever `settled` when none of those hold, so the ordering here
    // is documentation rather than arbitration.
    if (f.mergeConflict) {
      return {
        detail:
          "This was edited in two places at once, so the website could not work " +
          "out which version to use. Ask " + who + " to sort it out — nothing you " +
          "typed has been lost.",
        waitingOn: "a person to resolve two conflicting edits",
      };
    }
    if (f.awaitingReviewGate) {
      return {
        detail:
          "This is waiting for a person to look at how the pages will change before " +
          "it goes live. Ask " + who + " to approve the visual review.",
        waitingOn: "a person to approve the visual review",
      };
    }
    if (f.checksFailed) {
      return {
        detail:
          "One of the automatic safety checks did not pass, so this has not gone " +
          "live. Nothing you typed has been lost. Ask " + who + " to take a look.",
        waitingOn: "an automatic safety check that did not pass",
      };
    }
    if (f.deployState === "failure" || f.deployState === "error") {
      return {
        detail:
          "The website update did not finish. Nothing you typed has been lost. " +
          "Ask " + who + " to take a look.",
        waitingOn: "the website update, which did not finish",
      };
    }
    if (stalled) {
      // Two genuinely different situations, and conflating them is what made
      // the preview case invisible for as long as it was.
      if (f.previewOnly) {
        return {
          detail:
            "Everything passed, but this was edited on a preview of " +
            (f.baseRef ? "“" + f.baseRef + "”" : "another branch") +
            ", and a change made on a preview does not reach the live website " +
            "on its own. Nothing you typed has been lost — ask " + who +
            " to put it on the live website.",
          waitingOn: "a person to move this from the preview to the live website",
        };
      }
      return {
        detail:
          "Every check passed, but the website did not take the update. Nothing " +
          "you typed has been lost — ask " + who + " to finish putting it live.",
        waitingOn: "a person to finish putting this live",
      };
    }
    return {
      detail:
        "Something stopped this from going live. Nothing you typed has been lost. " +
        "Ask " + who + " to take a look.",
      waitingOn: "a person to take a look",
    };
  }

  // ── The derivation ────────────────────────────────────────────────────
  // Precedence is deliberate and load-bearing: a stopped publish outranks an
  // in-flight one, because an entry whose checks failed IS technically still
  // "armed" and would otherwise spin "Going live…" forever — the §2.4 defect
  // (claiming progress that is not happening) rather than the §2.4 defect of
  // claiming failure that is not real. Both are lies; this orders them so
  // neither is told.
  function derive(facts, options) {
    var f = facts || {};
    var opts = options || {};
    var now = isFiniteNumber(opts.now) ? opts.now : null;
    var contact = opts.contact || null;
    var modifiers = modifiersFor(f, now);
    var dest = destination(f);

    // A stall is a stopped publish (see the header): the merge had everything
    // it needed and did not happen, so believing `armed` past that point is
    // the "Going live… forever" defect #371 measured.
    var stalled = isStalled(f, now);
    var stopped =
      Boolean(f.mergeConflict) ||
      Boolean(f.awaitingReviewGate) ||
      Boolean(f.checksFailed) ||
      f.deployState === "failure" ||
      f.deployState === "error" ||
      stalled;

    if (stopped) {
      var copy = attentionCopy(f, contact, stalled);
      return {
        badge: BADGE.NEEDS_ATTENTION,
        label: "Needs attention",
        detail: copy.detail,
        waitingOn: copy.waitingOn,
        minutesLeft: null,
        modifiers: modifiers,
      };
    }

    var inFlight =
      Boolean(f.armed) || Boolean(f.merged) || f.deployState === "in_progress" ||
      f.deployState === "queued" || f.deployState === "pending";

    if (inFlight) {
      var mins = remainingMinutes(f, now);
      var waiting = f.merged
        ? "the website to finish updating"
        : f.waitingOn || "the automatic safety checks to finish";
      return {
        badge: BADGE.GOING_LIVE,
        label: mins === null ? "Going live… (about 5–15 minutes)" : "Going live… (about " + mins + " minute" + (mins === 1 ? "" : "s") + " left)",
        detail:
          "This is on its way to " + dest.noun + ". It is waiting for " + waiting + ". " +
          "You can close this tab — it carries on without you." +
          (dest.preview ? " It is not going to the live website." : ""),
        waitingOn: waiting,
        minutesLeft: mins,
        modifiers: modifiers,
      };
    }

    if (f.hasOpenPr) {
      return {
        badge: BADGE.DRAFT,
        label: "Draft — only you can see this",
        detail:
          "This is saved, but it is not on " + dest.noun + " yet. Click Publish to " +
          "put it on " + dest.noun + "." +
          (dest.preview ? " It will not go to the live website." : ""),
        waitingOn: null,
        minutesLeft: null,
        modifiers: modifiers,
      };
    }

    return {
      badge: BADGE.LIVE,
      label: "Live",
      detail: "This is on " + dest.noun + " now.",
      waitingOn: null,
      minutesLeft: null,
      modifiers: modifiers,
    };
  }

  var api = {
    BADGE: BADGE,
    MODIFIER_LABELS: MODIFIER_LABELS,
    SHORT_LABELS: SHORT_LABELS,
    BADGE_COLORS: BADGE_COLORS,
    CHECKS_NOMINAL_MIN: CHECKS_NOMINAL_MIN,
    DEPLOY_NOMINAL_MIN: DEPLOY_NOMINAL_MIN,
    STALL_GRACE_MIN: STALL_GRACE_MIN,
    derive: derive,
    isStalled: isStalled,
    destination: destination,
    modifiersFor: modifiersFor,
    remainingMinutes: remainingMinutes,
    parseDate: parseDate,
    formatDate: formatDate,
  };

  if (typeof window !== "undefined") window.CMSEntryStatus = api;
})();
