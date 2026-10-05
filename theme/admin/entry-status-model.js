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
 *   draft           Saved, not on the site yet.
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
 *    then labels the PR `cms/preview-only`. Publishing there merges the edit
 *    into that feature branch, so it is not on the live site now, and it
 *    reaches the live site later only when that branch does: nothing removes
 *    it on the way (#532). So on that surface every sentence containing "the
 *    website" was false, and so was any sentence promising the edit would
 *    never get there. §2.8 measured the only thing distinguishing that admin
 *    from the real one as a 0.65rem pill in a corner; this puts it in the
 *    sentence the editor is already reading, where it cannot be missed.
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

  // Nominal durations for the ETA, MEASURED on the 15 most recent merged
  // cms/* PRs on adamdaniel.ai (#3841-#3857, 2026-09-28): first check start →
  // merged, median 3.9 min (p80 5.0); merged → production deployed, median
  // 0.67 min (p80 0.72); the whole trip, median 4.6 min (p80 5.5, max 6.3).
  // The old figures (12 + 2, from a "5-15 min" guess) put the first reading
  // near three times the truth, and counted down to the MERGE rather than to
  // the page being live (#3857). A countdown that runs past zero reads as
  // broken, so an overrun says "taking a little longer than usual" instead.
  var CHECKS_NOMINAL_MIN = 4;
  var DEPLOY_NOMINAL_MIN = 1;
  var TYPICAL_PHRASE = "usually about " + (CHECKS_NOMINAL_MIN + DEPLOY_NOMINAL_MIN) + " minutes";
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

  // How much longer until LIVE, in whole minutes, or null when we cannot tell
  // (no start time) or the estimate has run out (see `overran`). Returning
  // null is REQUIRED behavior, not a gap: a made-up number here would be the
  // §2.4 defect in a new costume. Before the merge the remaining trip is the
  // rest of the checks PLUS the deploy; after it, the deploy alone.
  //
  // It never goes back up and never runs out early (#643). It rounds UP, so
  // "about 1 minute" lasts the whole last minute: rounding to nearest
  // declared the estimate run out with half a minute of it left, and after a
  // merge (a one-minute deploy estimate) that meant "longer than usual" 30 s
  // in. And after the merge it is also capped by what was left of the whole
  // trip, from `checksStartedAt`, so a switch of clock at the merge cannot
  // turn "longer than usual" back into "about 1 minute".
  function remainingMinutes(facts, now) {
    var f = facts || {};
    var elapsed = elapsedMinutes(f.startedAt, now);
    if (elapsed === null) return null;
    var trip = CHECKS_NOMINAL_MIN + DEPLOY_NOMINAL_MIN;
    var left = (f.merged ? DEPLOY_NOMINAL_MIN : trip) - elapsed;
    var sinceTripStart = f.merged ? elapsedMinutes(f.checksStartedAt, now) : null;
    if (sinceTripStart !== null) left = Math.min(left, trip - sinceTripStart);
    return left > 0 ? Math.ceil(left) : null;
  }

  function overran(facts, now) {
    return elapsedMinutes((facts || {}).startedAt, now) !== null && remainingMinutes(facts, now) === null;
  }

  // ── The checks, in words ──────────────────────────────────────────────
  // Keyed by the part of a check's name before " / " — the caller JOB id each
  // consumer's thin caller dictates (examples/site/.github/workflows), so one
  // workflow's matrix of jobs is ONE check to the editor. The value names
  // what the check does, in words the editor already uses; a raw id such as
  // "e2e / e2e" in the bar was #3857's complaint.
  //
  // Each name says what the check actually tests. `prerelease-guard`
  // (platform-prerelease-guard.yml → scripts/assert-release-pin.js) fails
  // when the site's platform.lock pins a trial build (`vX.Y.Z-rc.N`) of the
  // shared publishing system, and its caller runs only on changes headed for
  // the main branch — so it guards against the live site being built with an
  // unfinished version of that system, not anything about the post (#534).
  var DESTINATION_TOKEN = "{{destination}}";
  var CHECK_NAMES = {
    e2e: "the check that {{destination}} works on phones, tablets and computers",
    parity: "the check that the preview page loads without errors",
    "preview-media": "the check that images show on the preview",
    "site-verify": "the check that {{destination}} has every page and file it needs",
    "visual-regression": "the check for unexpected changes to how pages look",
    editorial: "the check that the post's details are filled in correctly",
    scan: "the scan for passwords or keys pasted in by mistake",
    "prerelease-guard":
      "the check that {{destination}} will be built with a finished version of its publishing system, not a trial one",
    reap: "a housekeeping step",
    preview: "building the preview",
    "auto-merge": "the automatic publish step",
  };
  var UNKNOWN_CHECK = "an automatic safety check";

  function checkName(key, destinationName) {
    var name = Object.prototype.hasOwnProperty.call(CHECK_NAMES, key) ? CHECK_NAMES[key] : UNKNOWN_CHECK;
    return name.split(DESTINATION_TOKEN).join(destinationName || "the destination");
  }

  function joinNames(names) {
    if (names.length <= 1) return names.join("");
    return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
  }

  // What an in-flight, not-yet-merged publish is waiting on, as "x of y".
  function waitingOnChecks(checks, destinationName) {
    var total = checks.total || 0;
    var pending = Array.isArray(checks.pending) ? checks.pending : [];
    if (!total) return "the automatic safety checks to start";
    var names = pending.map(function (key) {
      return checkName(key, destinationName);
    });
    if (pending.length === 1) {
      return "the last of " + total + " automatic safety checks (" + names[0] + ")";
    }
    return pending.length + " of " + total + " automatic safety checks to finish (" + joinNames(names) + ")";
  }

  // Every check passed and only the merge is left: a finished fact, so it is
  // its own sentence rather than the object of "It is waiting for", which
  // read "It is waiting for all 2 automatic safety checks passed" (#643).
  // Null while any check is pending or none has started.
  function checksPassed(checks) {
    var total = checks.total || 0;
    var pending = Array.isArray(checks.pending) ? checks.pending : [];
    if (!total || pending.length) return null;
    var subject =
      total === 1
        ? "The automatic safety check"
        : (total === 2 ? "Both " : "All " + total + " ") + "automatic safety checks";
    return subject + " passed; now putting it live";
  }

  // ── Modifiers ─────────────────────────────────────────────────────────
  // `published === false` is Hidden. `undefined` is NOT hidden: collections
  // without a `published` field (jodidaniel.com's nine section collections,
  // every file collection) must not acquire a modifier they have no control
  // over.
  function modifiersFor(facts, now, options) {
    var f = facts || {};
    var host = (options && options.currentHostname) || "this address";
    var out = [];
    if (f.published === false) {
      out.push({
        key: "hidden",
        label: MODIFIER_LABELS.hidden,
        detail:
          "You have this switched off, so it will not show on " + host + " even " +
          "once it is live. Turn “Published” on to show it.",
      });
    }
    var when = parseDate(f.publishDate);
    if (when !== null && isFiniteNumber(now) && when > now) {
      out.push({
        key: "scheduled",
        label: MODIFIER_LABELS.scheduled + " for " + formatDate(when),
        detail: "This appears on " + host + " automatically on " + formatDate(when) + ".",
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
  //
  // `laterNote` is the one sentence every preview surface uses for the live
  // site. "It will not go there" was false: publishing on a preview merges
  // the edit into that branch, and it reaches the live site whenever that
  // branch does (#532). So it says "not until", which is true whether or not
  // the branch ever goes live, and promises nothing in either direction.
  function destination(facts, options) {
    var f = facts || {};
    var opts = options || {};
    var canonical = opts.canonicalHostname || "the published destination";
    if (!f.previewOnly) return { noun: canonical, canonical: canonical, preview: false };
    var current = opts.currentHostname;
    var branch = f.baseRef ? "“" + f.baseRef + "”" : "this branch";
    var previewNoun = current && current !== canonical ? current : "the preview for " + branch;
    return {
      noun: previewNoun,
      canonical: canonical,
      preview: true,
      laterNote: "It will not reach " + canonical + " until the work on " + branch + " goes live there.",
    };
  }

  // ── The run link ──────────────────────────────────────────────────────
  // One phrase in the sentence may link to the check's workflow run
  // (`checksUrl`, found by publish-progress.js). It is for whoever the editor
  // asks for help, so the sentence still names that person; the link only
  // saves them the hunt. The URL comes off a check run a GitHub App wrote, so
  // nothing but an https://github.com/ URL is ever handed to an href.
  var GITHUB_URL = /^https:\/\/github\.com\//;

  function checksLink(url, text) {
    if (typeof url !== "string" || !GITHUB_URL.test(url) || !text) return null;
    return { text: text, href: url };
  }

  // ── Needs-attention copy ──────────────────────────────────────────────
  // Every branch names ONE thing a non-technical person can actually do.
  // A raw Actions URL is not an action for this audience (§4 phase 4), so
  // the contact is named instead; `contact` comes from the site's own
  // window.CMS_SUPPORT_CONTACT, falling back to a generic noun rather than
  // to a broken link. The failed-check branch also links "did not pass" to
  // the run (see "The run link"), for the person the editor asks.
  function attentionCopy(facts, contact, stalled, dest) {
    var f = facts || {};
    var host = dest.canonical;
    var who = contact || "whoever looks after " + host;
    // Ordered before the generic fallback but AFTER every specific cause: a
    // PR is only ever `settled` when none of those hold, so the ordering here
    // is documentation rather than arbitration.
    if (f.mergeConflict) {
      return {
        detail:
          "This was edited in two places at once, so " + dest.noun + " could not work " +
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
        link: checksLink(f.checksUrl, "did not pass"),
      };
    }
    if (f.deployState === "failure" || f.deployState === "error") {
      return {
        detail:
          "The update to " + dest.noun + " did not finish. Nothing you typed has been lost. " +
          "Ask " + who + " to take a look.",
        waitingOn: "the update to " + dest.noun + ", which did not finish",
      };
    }
    if (stalled) {
      // Two genuinely different situations, and conflating them is what made
      // the preview case invisible for as long as it was. On a preview the
      // stalled merge is the one into the feature branch, so that is what a
      // person is asked to finish; the live site comes later, with the
      // branch, in the same `laterNote` words as every other preview state
      // (#532).
      if (f.previewOnly) {
        return {
          detail:
            "Every check passed, but this has not been added to " + dest.noun +
            " yet. Nothing you typed has been lost — ask " + who +
            " to finish adding it. " + dest.laterNote,
          waitingOn: "a person to finish adding this to " + dest.noun,
        };
      }
      return {
        detail:
          "Every check passed, but " + host + " did not take the update. Nothing " +
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
  // ── The site gate (#625 item 1) ───────────────────────────────────────
  // A site can be GATED (coming-soon mode): everything published is kept, but
  // visitors see only the coming-soon page until the site is switched on, so
  // "it then takes about 5 minutes to appear" would promise what they never
  // see. site-gate-banner.js already resolves that state (branch-aware, cached)
  // and shows its banner exactly while the site is gated; the banner's presence
  // IS the state, so every publishing surface reads it from there instead of
  // making a second GitHub request. No banner (not gated, no gate declared,
  // not yet resolved) reads as not gated: saying nothing is the safe default.
  var GATE_BANNER_ID = "cms-site-gate-banner";
  var GATED_NOTE =
    "visitors keep seeing the coming-soon page until the site is switched on";

  function isSiteGated(doc) {
    try {
      var d = arguments.length ? doc : typeof document !== "undefined" ? document : null;
      return Boolean(d && typeof d.getElementById === "function" && d.getElementById(GATE_BANNER_ID));
    } catch (e) {
      return false;
    }
  }

  function derive(facts, options) {
    var f = facts || {};
    var opts = options || {};
    var now = isFiniteNumber(opts.now) ? opts.now : null;
    var contact = opts.contact || null;
    var modifiers = modifiersFor(f, now, opts);
    var dest = destination(f, opts);

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
      var copy = attentionCopy(f, contact, stalled, dest);
      return {
        badge: BADGE.NEEDS_ATTENTION,
        label: "Needs attention",
        detail: copy.detail,
        detailLink: copy.link || null,
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
      var passed = !f.merged && f.checks ? checksPassed(f.checks) : null;
      var waiting = f.merged
        ? dest.noun + " to finish updating"
        : passed
          ? passed
          : f.checks
            ? waitingOnChecks(f.checks, dest.noun)
            : f.waitingOn || "the automatic safety checks to finish";
      var when =
        mins !== null
          ? "about " + mins + " minute" + (mins === 1 ? "" : "s") + " left"
          : overran(f, now)
            ? "taking a little longer than usual"
            : TYPICAL_PHRASE;
      return {
        badge: BADGE.GOING_LIVE,
        label: "Going live… (" + when + ")",
        detail:
          "This is on its way to " + dest.noun + ". " + (passed ? "" : "It is waiting for ") + waiting + ". " +
          "You can close this tab — it carries on without you." +
          (dest.preview ? " " + dest.laterNote : ""),
        // Checks phase only: once merged, `waiting` is the deploy, not a check.
        // Links `waiting` — the phrase actually in `detail` — not the raw
        // `waitingOn` fact, which the poller no longer sets (it reports
        // `checks` and the words are made here).
        detailLink: f.merged ? null : checksLink(f.checksUrl, waiting),
        waitingOn: waiting,
        minutesLeft: mins,
        modifiers: modifiers,
      };
    }

    if (f.hasOpenPr) {
      return {
        badge: BADGE.DRAFT,
        label: "Draft — not on the site yet",
        detail: opts.gated
          ? "This is saved, but it is not on " + dest.noun + " yet. Click Publish to add it to " +
            "the site — " + GATED_NOTE + "."
          : "This is saved, but it is not on " + dest.noun + " yet. Click Publish to " +
            "put it on " + dest.noun + "." +
            (dest.preview ? " " + dest.laterNote : ""),
        detailLink: null,
        waitingOn: null,
        minutesLeft: null,
        modifiers: modifiers,
      };
    }

    return {
      badge: BADGE.LIVE,
      label: "Live",
      detail: opts.gated
        ? "This is saved on " + dest.noun + ", but " + GATED_NOTE + "."
        : "This is on " + dest.noun + " now." + (dest.preview ? " " + dest.laterNote : ""),
      detailLink: null,
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
    CHECK_NAMES: CHECK_NAMES,
    TYPICAL_PHRASE: TYPICAL_PHRASE,
    DEPLOY_NOMINAL_MIN: DEPLOY_NOMINAL_MIN,
    STALL_GRACE_MIN: STALL_GRACE_MIN,
    derive: derive,
    isSiteGated: isSiteGated,
    GATED_NOTE: GATED_NOTE,
    isStalled: isStalled,
    destination: destination,
    modifiersFor: modifiersFor,
    remainingMinutes: remainingMinutes,
    parseDate: parseDate,
    formatDate: formatDate,
  };

  if (typeof window !== "undefined") window.CMSEntryStatus = api;
})();
