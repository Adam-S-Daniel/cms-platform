/*
 * admin/publish-progress.js — the facts behind "is this on the website?".
 *
 * ── The defect this closes (docs/PUBLISHING-UX.md §2.4) ────────────────
 * After "Publish now" an editor's complete feedback is:
 *
 *   1. a toast from publish-via-auto-merge.js, removed after 14 s;
 *   2. Decap's own red "failed to publish" error, which is WRONG — the
 *      shim hands Decap a deliberate 422 so it never deletes the head ref;
 *   3. then nothing at all, for five to fifteen minutes;
 *   4. and only THEN deploy-status-pill.js has something to show, because
 *      it polls GitHub Deployments and deploy-production registers one
 *      only AFTER the merge.
 *
 * So the longest phase of the most consequential action in the product —
 * the required checks — has no signal whatsoever, and the one signal it
 * does have says the opposite of the truth.
 *
 * This module is the missing half: it polls the ENTRY'S OWN PULL REQUEST,
 * which exists from the moment of Save, and reports the whole window. It
 * gathers facts only; the words are entry-status-model.js's job and the
 * rendering is publish-step-hint.js's, so a single derivation feeds every
 * surface and they cannot drift (§2.9).
 *
 * ── Public DOM + public REST only ──────────────────────────────────────
 * The house rule for everything in theme/admin/: no window.CMS internals,
 * no Decap Redux store. The entry is identified from `location.hash`, which
 * is Decap's own public route, and the PR from the `cms/<collection>/<slug>`
 * branch convention that publish-via-auto-merge.js creates and
 * posts-list-enhance.js already queries. Auth is the editor's own Decap
 * token out of localStorage — the same one deploy-status-pill.js uses. No
 * CMS_E2E_PAT, no second credential.
 *
 * ── The facts, and where each comes from ───────────────────────────────
 *   hasOpenPr         an open PR whose head ref is cms/<collection>/<slug>
 *   armed             cms/ready or decap-cms/pending_publish on that PR, or
 *                     native auto_merge already enabled
 *   merged            the PR merged; the deploy is the only step left
 *   checksFailed      any check run on the head sha concluded failure /
 *                     timed_out / cancelled  (cancelled counts: a cancelled
 *                     REQUIRED context blocks the merge and nothing
 *                     overrides it — docs/CI-INVARIANTS.md, #1815/#285/#289)
 *   awaitingReviewGate a workflow run on the head sha is `waiting`, which is
 *                     exactly and only GitHub's state for a run parked on a
 *                     manual environment approval — the regression-review
 *                     gate of §2.7, the failure mode that presents to an
 *                     editor as "pressed Publish, nothing happened, forever"
 *   previewOnly       the PR's base is NOT the repo's default branch — i.e.
 *                     this admin is a PR-preview deploy, whose config.yml
 *                     scripts/patch-preview-config.sh rewrote to the preview
 *                     branch. Both signals come free out of the /pulls LIST
 *                     response, so this costs no extra request: the
 *                     `cms/preview-only` label cms-editorial-workflow.yml
 *                     applies, OR base.ref !== base.repo.default_branch. The
 *                     label alone would be racy (it is applied a few seconds
 *                     after `opened`); the branch compare alone would miss a
 *                     site whose default branch is not what the ruleset
 *                     protects. Neither hardcodes `main`.
 *   settledSince      ms epoch at which this PR FIRST looked settled-but-
 *                     unmerged, or null. See "The stall" below.
 *
 * ── The stall: an armed publish with nothing left to wait for (#371) ────
 * `armed` says the PR is queued to merge itself. Nothing said whether that
 * queue ever moves, so every failure of the merge machinery presented as
 * "Going live…" FOREVER — honest about what it knew and, after ten minutes,
 * indistinguishable from a lie. Measured instance: jodidaniel.com#233, armed
 * at 22:05, every check green by 22:06, still open and unmerged twenty
 * minutes later when a human merged it by hand.
 *
 * The signal is POSITIVE and needs no timer and no threshold guess: a PR that
 * is armed, has at least one check run, has NO incomplete check run, nothing
 * red, no conflict and no review-gate park has NOTHING LEFT TO WAIT FOR — so
 * if it is still open, the merge is not coming on its own. That is a fact
 * about the PR, not an elapsed-time heuristic.
 *
 * One timestamp is still recorded rather than reporting the stall instantly,
 * because there is a legitimate seconds-wide window in which it holds: native
 * auto-merge fires a moment AFTER the last check completes. `settledSince`
 * is when the condition first held CONTINUOUSLY (reset on any change of PR or
 * head sha, and on the condition lapsing); entry-status-model.js applies the
 * grace period, so the threshold lives in the pure, unit-tested module and
 * this one stays a fact-gatherer.
 *
 * `startedAt` for the ETA is the OLDEST `started_at` among the check runs
 * that have not completed — deliberately not "when this tab noticed", so a
 * reload mid-flight does not restart the estimate, and not the label's own
 * timestamp, which would cost an extra timeline request per tick.
 *
 * ── Budget ─────────────────────────────────────────────────────────────
 * At most five GitHub requests per 30 s tick, and only while the tab is
 * VISIBLE and the route is an entry route. That is ~600/hour against an
 * authenticated 5000/hour budget, alongside deploy-status-pill.js's own
 * ~480. A hidden tab polls nothing: an admin left open in a background tab
 * overnight must not spend the editor's rate limit on an entry nobody is
 * looking at.
 *
 * Every fetch degrades to "no facts" rather than throwing — a rate limit, a
 * revoked token or an offline laptop leaves the surfaces showing their last
 * known state, never a page error.
 *
 * ── Why every read says `cache: "no-cache"` (#386) ────────────────────
 * GitHub REST responses carry `Cache-Control: private, max-age=60`, and a
 * browser fetch() honours it: for 60 s after any GET the same URL is
 * answered from Chromium's HTTP cache without touching the network. For a
 * poller that is fatal — every refresh() inside that minute returned the
 * snapshot from BEFORE the label it was polling for landed, so the bar sat
 * on "Publish" for a full minute after the PR was armed (measured:
 * adamdaniel.ai host-loop run 33580693718, every /pulls read for 58 s
 * answered in 1 ms). `no-cache` still lets the browser revalidate with
 * If-None-Match, and a 304 does not count against the rate limit, so the
 * budget above is unchanged. e2e/admin-github-fetch-cache.test.js holds
 * the line for every shim.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__publishProgressInstalled) return;
  window.__publishProgressInstalled = true;

  var REPO = window.CMS_REPO;
  var API = "https://api.github.com/repos/" + REPO;
  var POLL_MS = 30 * 1000;
  // Labels that mean "this PR is queued to merge itself". Both are real
  // arming signals on this platform: publish-via-auto-merge.js writes
  // `cms/ready`, and Decap's own Status→Ready writes
  // `decap-cms/pending_publish` — the same auto-merge-when-ready job fires
  // on either (§2.2). one-door-publish.js hides the second route on the
  // production shell, but a PR armed that way BEFORE the shim shipped is
  // still in flight and must still read as in flight.
  var ARMED_LABELS = ["cms/ready", "decap-cms/pending_publish"];
  var FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "stale"];
  // Applied by cms-editorial-workflow.yml's "Apply draft label on new PR" step
  // to every CMS PR whose base is not `main`.
  var PREVIEW_ONLY_LABEL = "cms/preview-only";

  // When the settled-but-unmerged condition first held, and for which
  // <pr>:<sha>. Any change of either resets it, so a re-save (Decap
  // force-pushes the same branch) starts the clock over rather than
  // inheriting a stall reading from the previous head.
  var settled = { key: null, since: null };

  function noteSettled(key, isSettled, now) {
    if (!isSettled) {
      settled = { key: null, since: null };
      return null;
    }
    if (settled.key !== key) settled = { key: key, since: now };
    return settled.since;
  }

  var listeners = [];
  var state = { ready: false, facts: null, prNumber: null, prUrl: null, entry: null };

  function getToken() {
    try {
      var raw = localStorage.getItem("decap-cms-user");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed.token : null;
    } catch (e) {
      return null;
    }
  }

  function headers(token) {
    return {
      Authorization: "token " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  // Every call site treats null as "no facts this tick" and keeps the last
  // render. Never throws.
  async function getJson(url, token, label) {
    try {
      var res = await fetch(url, { headers: headers(token), cache: "no-cache" });
      if (!res.ok) {
        console.info("[publish-progress] " + label + " HTTP " + res.status + " — skipping tick.");
        return null;
      }
      return await res.json();
    } catch (err) {
      console.info(
        "[publish-progress] " + label + " unavailable: " +
          (err && err.message ? err.message : String(err)),
      );
      return null;
    }
  }

  // ── Route → entry ─────────────────────────────────────────────────────
  // Decap's own hash routes. `#/collections/<name>/entries/<slug>` is an
  // existing entry; `/new` has no branch yet and no PR, so it is not an
  // entry for this module's purposes.
  function currentEntry() {
    var hash = location.hash || "";
    var m = /#\/collections\/([^/]+)\/entries\/([^/?]+)/.exec(hash);
    if (!m) return null;
    return { collection: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
  }

  // Decap's editorial-workflow branch for an entry is
  // `cms/<contentKey>` where contentKey is `<collection>/<slug>` — the
  // convention publish-via-auto-merge.js's delete-recovery also writes.
  function branchFor(entry) {
    return "cms/" + entry.collection + "/" + entry.slug;
  }

  function matchesEntry(ref, entry) {
    if (!ref) return false;
    var want = branchFor(entry);
    if (ref === want) return true;
    // Lenient tail match: Decap sanitizes some slugs on the way into a
    // branch name, so an exact compare alone would silently report "no PR"
    // (which renders as Live) for an entry that has one. Erring toward
    // matching is the safe direction here — the wrong answer in the other
    // direction tells an editor a draft is already on the website.
    return ref.indexOf("cms/" + entry.collection + "/") === 0 && ref.slice(-entry.slug.length) === entry.slug;
  }

  // ── Fact gathering ────────────────────────────────────────────────────
  async function gather(token, entry) {
    var prs = await getJson(API + "/pulls?state=open&per_page=100", token, "open pulls");
    if (prs === null) return null;

    var pr = (Array.isArray(prs) ? prs : []).filter(function (p) {
      return matchesEntry(p.head && p.head.ref, entry);
    })[0];

    if (!pr) {
      // No open PR. Either it merged and is live/deploying, or it was never
      // saved as a draft. deploy-status-pill.js owns the production
      // deployment, so read it here only to distinguish "deploying" from
      // "live" — one request, and only on this branch.
      var dep = await latestProductionStatus(token);
      var deploying = dep && (dep.state === "in_progress" || dep.state === "queued" || dep.state === "pending");
      return {
        facts: {
          hasOpenPr: false,
          armed: false,
          merged: Boolean(deploying),
          checksFailed: false,
          mergeConflict: false,
          awaitingReviewGate: false,
          deployState: dep ? dep.state : null,
          waitingOn: null,
          startedAt: dep && deploying ? Date.parse(dep.created_at) : null,
          previewOnly: false,
          baseRef: null,
          settledSince: noteSettled(null, false, Date.now()),
        },
        prNumber: null,
        prUrl: null,
      };
    }

    var labels = (pr.labels || []).map(function (l) {
      return typeof l === "string" ? l : l.name;
    });
    var armed =
      Boolean(pr.auto_merge) ||
      ARMED_LABELS.some(function (name) {
        return labels.indexOf(name) !== -1;
      });

    // Free out of the list response — `base.repo` is a full repository
    // object, so `default_branch` costs nothing. OR-ing the two signals errs
    // toward "this is a preview", which is the safe direction: the wrong
    // answer the other way tells an editor on a preview that their change is
    // going to the live website.
    var baseRef = (pr.base && pr.base.ref) || null;
    var defaultBranch = (pr.base && pr.base.repo && pr.base.repo.default_branch) || null;
    var previewOnly =
      labels.indexOf(PREVIEW_ONLY_LABEL) !== -1 ||
      Boolean(baseRef && defaultBranch && baseRef !== defaultBranch);

    var sha = pr.head && pr.head.sha;
    var checks = sha ? await getJson(API + "/commits/" + sha + "/check-runs?per_page=100", token, "check-runs") : null;
    var runs = checks && Array.isArray(checks.check_runs) ? checks.check_runs : [];

    var failed = runs.some(function (r) {
      return r.status === "completed" && FAILED_CONCLUSIONS.indexOf(r.conclusion) !== -1;
    });

    var incomplete = runs.filter(function (r) {
      return r.status !== "completed";
    });
    var startedAt = null;
    incomplete.forEach(function (r) {
      var t = Date.parse(r.started_at || "");
      if (!isNaN(t) && (startedAt === null || t < startedAt)) startedAt = t;
    });

    // `mergeable` is NOT in the /pulls LIST response — only the single-PR
    // endpoint carries it, and GitHub computes it lazily (null until it has).
    // Reading it off the list would have left the merge-conflict branch dead
    // code that looked alive. One extra request, and only while a publish is
    // actually in flight, which is the only time a conflict can block one.
    var mergeConflict = false;
    if (armed) {
      var full = await getJson(API + "/pulls/" + pr.number, token, "pull " + pr.number);
      // Only an EXPLICIT false is a conflict. `null` means "not computed yet",
      // and reporting that as a conflict would tell an editor their work is
      // broken every time GitHub is a second behind.
      if (full && full.mergeable === false) mergeConflict = true;
    }

    // The park (§2.7). GitHub sets a workflow run's status to `waiting`
    // exactly and only while it is pending a manual environment approval,
    // so this is a positive signal rather than an inference from silence.
    var awaitingReviewGate = false;
    if (armed && sha && incomplete.length) {
      var wf = await getJson(API + "/actions/runs?head_sha=" + sha + "&per_page=20", token, "workflow runs");
      var wfRuns = wf && Array.isArray(wf.workflow_runs) ? wf.workflow_runs : [];
      awaitingReviewGate = wfRuns.some(function (r) {
        return r.status === "waiting";
      });
    }

    // See "The stall" in the header. `runs.length` guards the window between
    // a push and GitHub creating the check runs for it: an empty list is "not
    // known yet", never "nothing left to wait for".
    var settledSince = noteSettled(
      pr.number + ":" + (sha || ""),
      armed &&
        runs.length > 0 &&
        incomplete.length === 0 &&
        !failed &&
        !mergeConflict &&
        !awaitingReviewGate,
      Date.now(),
    );

    var waitingOn = null;
    if (incomplete.length === 1) {
      waitingOn = "one last check (" + incomplete[0].name + ")";
    } else if (incomplete.length > 1) {
      waitingOn = incomplete.length + " automatic safety checks to finish";
    }

    return {
      facts: {
        hasOpenPr: true,
        armed: armed,
        merged: false,
        checksFailed: failed,
        mergeConflict: mergeConflict,
        awaitingReviewGate: awaitingReviewGate,
        deployState: null,
        waitingOn: waitingOn,
        startedAt: startedAt,
        previewOnly: previewOnly,
        baseRef: baseRef,
        settledSince: settledSince,
      },
      prNumber: pr.number,
      prUrl: pr.html_url,
    };
  }

  async function latestProductionStatus(token) {
    var deps = await getJson(API + "/deployments?environment=production&per_page=1", token, "deployments");
    if (!Array.isArray(deps) || !deps.length) return null;
    var st = await getJson(API + "/deployments/" + deps[0].id + "/statuses?per_page=1", token, "deployment statuses");
    if (!Array.isArray(st) || !st.length) return null;
    return st[0];
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  function publish() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](state);
      } catch (e) {
        /* one bad subscriber must never stop the others */
      }
    }
  }

  var inFlight = false;
  async function tick() {
    if (inFlight) return;
    if (document.hidden) return; // see "Budget" in the header
    var entry = currentEntry();
    if (!entry) {
      if (state.entry !== null) {
        state = { ready: true, facts: null, prNumber: null, prUrl: null, entry: null };
        publish();
      }
      return;
    }
    var token = getToken();
    if (!token) return;
    inFlight = true;
    try {
      var result = await gather(token, entry);
      if (result === null) return; // keep the last known state
      state = {
        ready: true,
        facts: result.facts,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        entry: entry,
      };
      publish();
    } finally {
      inFlight = false;
    }
  }

  window.CMSPublishProgress = {
    get: function () {
      return state;
    },
    subscribe: function (fn) {
      if (typeof fn === "function") listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    // Called by publish-button.js the moment it arms a PR, so the editor
    // sees "Going live…" immediately rather than up to 30 s later.
    refresh: tick,
    currentEntry: currentEntry,
    branchFor: branchFor,
    matchesEntry: matchesEntry,
    getToken: getToken,
  };

  function start() {
    tick();
    setInterval(tick, POLL_MS);
    window.addEventListener("hashchange", tick);
    // A tab brought back to the front re-polls at once rather than waiting
    // out the remainder of a tick it skipped while hidden.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) tick();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
