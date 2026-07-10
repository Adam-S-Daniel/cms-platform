/*
 * admin/deploy-status-pill.js — surfaces deploy status (preview AND
 * production) in the Decap editor toolbar, peering with Decap's
 * built-in "Preview" link.
 *
 * Why both: Decap's built-in deploy-preview-links feature surfaces a
 * link once a deployment goes `success`, but it doesn't expose the
 * GitHub Actions run URL while the deploy is in flight, and it
 * doesn't show anything for production deploys at all (the github
 * backend doesn't track post-merge production deploys). This script
 * fills both gaps with two pills:
 *
 *   - Preview build status:  in_progress (link to deploy-preview run) /
 *                            failure (link to logs).
 *                            Hidden on success — Decap's built-in
 *                            preview link takes over.
 *   - Production publish status: in_progress (link to deploy-production
 *                            run) / failure (link to logs).
 *                            Hidden on success — the deployed-commit
 *                            pill covers the steady state.
 *
 * Wiring on the workflow side:
 *   - .github/workflows/deploy-preview.yml    → preview-pr-<N>
 *   - .github/workflows/deploy-production.yml → production
 *
 * Both register a GitHub Deployment with state=in_progress at job
 * start and update to success/failure at job end.
 *
 * Placement: injected INTO Decap's editor toolbar (next to the
 * built-in preview link) rather than floating in a viewport corner.
 * Decap re-renders the toolbar on entry switches and form mutations,
 * so the injection runs on a MutationObserver and is idempotent.
 *
 * Auth: uses the operator's Decap token from
 * `localStorage["decap-cms-user"].token`. No CMS_E2E_PAT.
 *
 * ── Robustness behaviours ─────────────────────────────────────────
 *
 *   1. Per-pill `lastSuccessfulPollAt` timestamps. If a pill is
 *      currently visible AND its last successful poll is older than
 *      STALE_THRESHOLD_MS (5 min), the pill flips to amber with
 *      "(status stale — last poll <ago>)" instead of disappearing
 *      silently. The href stays linked to the last-known run so an
 *      editor can still drill into the in-flight deploy.
 *
 *   2. Single-retry helper around fetch. Network errors and
 *      non-2xx-non-rate-limit responses retry once with a short
 *      backoff before surfacing a `console.warn` and giving up for
 *      this tick. Rate-limited responses (X-RateLimit-Remaining: 0)
 *      do NOT retry — that would just burn through the remaining
 *      budget. We surface a `console.warn` describing the reset
 *      window and let the next interval tick try again.
 *
 *   3. `console.info` one-liner whenever the polling tick can't find
 *      a deployment for the relevant ref/environment, so devtools
 *      shows the polling is alive even when the pill is hidden.
 *
 *   4. State-revert dedup is preserved: `lastSeenStatusIds` keys off
 *      the GitHub status.id, which changes on every new state event
 *      (success → in_progress → failure → …), so the pill re-renders
 *      cleanly through rapid transitions.
 *
 * ── Test contract ────────────────────────────────────────────────
 *
 * End-to-end coverage of the spinner→hidden transition lives in
 * the publish-loop specs:
 *
 *   e2e/cms-publish-loop.spec.js          → cms-prod-status-pill
 *   e2e/cms-publish-loop-preview.spec.js  → cms-preview-build-pill
 *
 * Both specs drive a real publish (Save → Status:Ready → merge →
 * deploy) and use the `waitForChangeReflected` helper in
 * `e2e/deploy-pill.js`: poll the public URL until it serves the
 * marker, watch the pill for failure-state transitions during the
 * wait, and finally assert the pill is in its terminal hidden
 * state. (The earlier "wait for spinner-visible then settled"
 * approach was racy — deploy-production / deploy-preview can
 * complete in <30 s, less than the pill's 30 s polling interval,
 * and the in_progress phase passes entirely between two polls.)
 * If the polling chain breaks or success → hidden transition stops
 * working, those specs surface it. The robustness invariants
 * (retry, rate-limit, stale-state amber) live in
 * e2e/deploy-status-pill-robustness.test.js as text-grep checks
 * against this file's source.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__deployStatusPillInstalled) return;
  window.__deployStatusPillInstalled = true;

  var REPO = window.CMS_REPO;
  var API = "https://api.github.com/repos/" + REPO;
  var POLL_MS = 30 * 1000;
  var PROD_PILL_ID = "cms-prod-status-pill";
  var PREVIEW_PILL_ID = "cms-preview-build-pill";
  // Five minutes — three failed-poll intervals at the 30s tick.
  var STALE_THRESHOLD_MS = 5 * 60 * 1000;
  // 1.5s breather between fetch attempts; long enough for a transient
  // network blip to clear without making the polling tick noticeably
  // slower when GitHub is healthy.
  var RETRY_DELAY_MS = 1500;

  // ── Auth + GitHub helpers ────────────────────────────────────────
  function getToken() {
    try {
      var raw = localStorage.getItem("decap-cms-user");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed.token : null;
    } catch {
      return null;
    }
  }

  function ghHeaders(token) {
    return {
      Authorization: "token " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function isRateLimited(res) {
    if (!res) return false;
    if (res.status !== 403 && res.status !== 429) return false;
    try {
      var remaining =
        res.headers && res.headers.get ? res.headers.get("X-RateLimit-Remaining") : null;
      // GitHub returns "X-RateLimit-Remaining: 0" with status 403 when
      // the primary rate limit trips. status 429 with no header is the
      // secondary/abuse limit; treat that as rate-limited too.
      if (res.status === 429) return true;
      return remaining === "0";
    } catch {
      return false;
    }
  }

  function rateLimitResetSummary(res) {
    try {
      var reset =
        res && res.headers && res.headers.get ? res.headers.get("X-RateLimit-Reset") : null;
      if (!reset) return "unknown";
      var when = new Date(parseInt(reset, 10) * 1000);
      return when.toISOString();
    } catch {
      return "unknown";
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // Fetch wrapper with single retry on transient failure. On rate
  // limit we DO NOT retry — that would just burn through the
  // remaining budget. The next 30s tick will try again, by which
  // time the reset window should have passed.
  //
  // Returns the Response object on success, or null on permanent
  // failure (after retry / on rate-limit). Each failure path emits
  // a console.warn so devtools surfaces what happened.
  async function fetchWithRetry(url, init, label) {
    var attempt = 0;
    var lastErr;
    while (attempt < 2) {
      attempt += 1;
      try {
        var res = await fetch(url, init);
        if (res.ok) return res;
        if (isRateLimited(res)) {
          console.warn(
            "[deploy-status-pill] " +
              label +
              " rate-limited (status " +
              res.status +
              "); waiting until reset (" +
              rateLimitResetSummary(res) +
              ") — no retry.",
          );
          return null;
        }
        // Other non-2xx — retry once, then give up.
        if (attempt < 2) {
          await delay(RETRY_DELAY_MS);
          continue;
        }
        console.warn(
          "[deploy-status-pill] " +
            label +
            " HTTP " +
            res.status +
            " after retry — giving up for this tick.",
        );
        return null;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await delay(RETRY_DELAY_MS);
          continue;
        }
      }
    }
    console.warn(
      "[deploy-status-pill] " +
        label +
        " network error after retry: " +
        (lastErr && lastErr.message ? lastErr.message : String(lastErr)),
    );
    return null;
  }

  async function fetchLatestStatusForEnvironment(token, environment) {
    var deplRes = await fetchWithRetry(
      API + "/deployments?environment=" + encodeURIComponent(environment) + "&per_page=1",
      { headers: ghHeaders(token) },
      "deployments?environment=" + environment,
    );
    if (!deplRes) return null;
    var deployments = await deplRes.json();
    if (!Array.isArray(deployments) || deployments.length === 0) return null;
    var latest = deployments[0];
    var statRes = await fetchWithRetry(
      API + "/deployments/" + latest.id + "/statuses?per_page=1",
      { headers: ghHeaders(token) },
      "deployments/" + latest.id + "/statuses",
    );
    if (!statRes) return null;
    var statuses = await statRes.json();
    if (!Array.isArray(statuses) || statuses.length === 0) return null;
    return { deployment: latest, status: statuses[0] };
  }

  // For preview, environment names are `preview-pr-<N>`. There's no
  // single name to query — list recent deployments and pick the most
  // recent that matches. The list API doesn't accept wildcards, so
  // we paginate by created_at desc and filter in JS.
  async function fetchLatestPreviewStatus(token) {
    var deplRes = await fetchWithRetry(
      API + "/deployments?per_page=20",
      { headers: ghHeaders(token) },
      "deployments (preview filter)",
    );
    if (!deplRes) return null;
    var deployments = await deplRes.json();
    var preview = (Array.isArray(deployments) ? deployments : []).filter(function (d) {
      return /^preview-pr-\d+$/.test(d.environment || "");
    })[0];
    if (!preview) return null;
    var statRes = await fetchWithRetry(
      API + "/deployments/" + preview.id + "/statuses?per_page=1",
      { headers: ghHeaders(token) },
      "deployments/" + preview.id + "/statuses",
    );
    if (!statRes) return null;
    var statuses = await statRes.json();
    if (!Array.isArray(statuses) || statuses.length === 0) return null;
    return { deployment: preview, status: statuses[0] };
  }

  // ── Pill rendering ───────────────────────────────────────────────
  // Render the pill for a fresh poll result.
  // - `state` falsy or "success" → hide.
  // - in_progress / queued / pending → blue spinner + "<label>…"
  // - failure / error → red "⚠ <label> failed — view logs"
  function renderPill(pill, label, state, logUrl) {
    if (!pill) return;
    if (!state || state === "success") {
      pill.style.display = "none";
      return;
    }
    pill.href = logUrl || "https://github.com/" + REPO + "/actions";

    if (state === "in_progress" || state === "queued" || state === "pending") {
      pill.style.color = "#0969da";
      pill.style.borderColor = "#0969da";
      pill.title = "Click to view the in-flight deploy run";
      // eslint-disable-next-line no-unsanitized/property -- static SVG markup; `label` is a hardcoded constant ("Publishing" / "Preview build"), never user input.
      pill.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" style="vertical-align:-1px;margin-right:0.4em" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="40 20" stroke-linecap="round">' +
        '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.2s" repeatCount="indefinite"/>' +
        "</circle></svg>" +
        "<span>" +
        label +
        "…</span>";
      pill.style.display = "";
    } else if (state === "failure" || state === "error") {
      pill.style.color = "#cf222e";
      pill.style.borderColor = "#cf222e";
      pill.title = "Click to view the failed deploy run";
      // eslint-disable-next-line no-unsanitized/property -- static markup; `label` is a hardcoded constant, never user input.
      pill.innerHTML = "<span>⚠ " + label + " failed — view logs</span>";
      pill.style.display = "";
    } else {
      pill.style.display = "none";
    }
  }

  // Format a millisecond age into a compact "5m ago" / "1h ago" form
  // for the stale-poll legend.
  function formatAgo(ms, nowMs) {
    var elapsed = Math.max(0, (nowMs || Date.now()) - ms);
    var mins = Math.round(elapsed / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.round(hrs / 24);
    return days + "d ago";
  }

  // Flip a currently-visible pill to the amber "stale" state when
  // polling has been broken for >STALE_THRESHOLD_MS. The pill keeps
  // its href so the editor can still drill into the last-known run.
  function renderStalePill(pill, label, lastPollAt, nowMs) {
    if (!pill) return;
    pill.style.color = "#9a6700";
    pill.style.borderColor = "#d4a72c";
    pill.title =
      "Polling for " +
      label +
      " status hasn't succeeded recently — " +
      "the displayed state may be out of date. Click to view the last-known run.";
    // eslint-disable-next-line no-unsanitized/property -- static markup; `label` is a hardcoded constant and `formatAgo` returns a numeric-derived time string, never user input.
    pill.innerHTML =
      '<span aria-hidden="true" style="margin-right:0.35em">⚠</span>' +
      "<span>" +
      label +
      " (status stale — last poll " +
      formatAgo(lastPollAt, nowMs) +
      ")</span>";
    pill.style.display = "";
  }

  // ── Toolbar insertion ────────────────────────────────────────────
  // Decap's toolbar's emotion-class label has been observed as either
  // `EditorToolbar` or `ToolbarContainer`; both contain "oolbar" in
  // their className. Mirror native-preview-href.js's selector.
  function findToolbar() {
    return document.querySelector('[class*="oolbar"]');
  }

  function buildPill(id) {
    var a = document.createElement("a");
    a.id = id;
    // Deployment metadata, not content — excluded from the visual-regression
    // text diff (a run racing a deploy must not flag transient pill states).
    a.setAttribute("data-visreg-ignore", "");
    a.target = "_blank";
    a.rel = "noopener";
    // Inline-block so it sits in the toolbar's natural row. We
    // insert at the LEFT of the toolbar (before the action group)
    // rather than appending to the right — on narrow / mobile
    // viewports the right-anchored toolbar overflows the viewport
    // and clips trailing children. Anchoring to the left keeps the
    // "Publishing…" spinner visible regardless of width.
    //
    // `order:-1` is set so that even if Decap wraps children in a
    // flex container with arbitrary order values, the pill still
    // floats to the start of the row.
    a.style.cssText =
      [
        "display:none",
        "order:-1",
        "margin-right:0.5rem",
        "padding:0.2rem 0.55rem",
        "background:rgba(255,255,255,0.95)",
        "border:1px solid #d0d7de",
        "border-radius:3px",
        "color:#57606a",
        "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
        "font-size:0.7rem",
        "letter-spacing:0.03em",
        "text-decoration:none",
        "vertical-align:middle",
        "cursor:pointer",
        "transition:border-color 0.15s,color 0.15s",
      ].join(";") + ";";
    return a;
  }

  function ensurePillInToolbar(id) {
    var existing = document.getElementById(id);
    if (existing && existing.parentNode) return existing;
    var toolbar = findToolbar();
    if (!toolbar) return null;
    var pill = existing || buildPill(id);
    // Insert at the START of the toolbar (before the existing
    // action group) so the pill stays inside the viewport on narrow
    // widths. The toolbar overflows to the right on mobile, so a
    // right-appended child gets clipped; a left-prepended one stays
    // visible. `insertBefore(pill, toolbar.firstChild)` is
    // equivalent to `prepend(pill)` but works in IE-era polyfill
    // setups without an extra shim.
    if (toolbar.firstChild) {
      toolbar.insertBefore(pill, toolbar.firstChild);
    } else {
      toolbar.appendChild(pill);
    }
    return pill;
  }

  function isPillVisible(pill) {
    return Boolean(pill) && pill.style.display !== "none";
  }

  // ── Polling loop ─────────────────────────────────────────────────
  // Per-pill bookkeeping. `lastSeenStatusIds` keys off GitHub's
  // status.id which changes on every transition, so a state revert
  // (success → in_progress when a re-publish fires) trips a fresh
  // render. `lastSuccessfulPollAt` stamps a wall-clock the moment a
  // poll completes successfully — used to flip a visible pill to the
  // amber stale state when the polling chain has been broken for
  // longer than STALE_THRESHOLD_MS.
  var lastSeenStatusIds = { prod: null, preview: null };
  var lastSuccessfulPollAt = { prod: null, preview: null };

  // Single iteration of the polling loop.
  // 1. ensure both pills are attached (no-op when toolbar isn't rendered)
  // 2. fetch each environment's latest deployment + status
  // 3. on success: render fresh state, stamp lastSuccessfulPollAt
  // 4. on no-deployment: hide pill, console.info diagnostic
  // 5. on fetch failure: leave existing render, but if the pill is
  //    visible AND lastSuccessfulPollAt is stale, flip to amber.
  async function tick() {
    var token = getToken();
    if (!token) return;

    var prodPill = ensurePillInToolbar(PROD_PILL_ID);
    var previewPill = ensurePillInToolbar(PREVIEW_PILL_ID);
    if (!prodPill && !previewPill) return; // no toolbar yet (collection list view)

    var now = Date.now();

    if (prodPill) {
      var prodResult = await pollOne({
        pill: prodPill,
        label: "Publishing",
        kind: "prod",
        environmentLabel: "production",
        fetchFn: function () {
          return fetchLatestStatusForEnvironment(token, "production");
        },
        now: now,
      });
      if (prodResult === null) {
        // Permanent failure (rate limit / network) — see if we should
        // flip a visible pill to amber.
        applyStaleIfNeeded(prodPill, "Publishing", lastSuccessfulPollAt.prod, now);
      }
    }

    if (previewPill) {
      var previewResult = await pollOne({
        pill: previewPill,
        label: "Preview build",
        kind: "preview",
        environmentLabel: "preview-pr-<N>",
        fetchFn: function () {
          return fetchLatestPreviewStatus(token);
        },
        now: now,
      });
      if (previewResult === null) {
        applyStaleIfNeeded(previewPill, "Preview build", lastSuccessfulPollAt.preview, now);
      }
    }
  }

  // Returns:
  //   true  — succeeded (rendered fresh state OR confirmed no deployment)
  //   null  — permanent fetch failure (caller should consider stale)
  async function pollOne(args) {
    var pill = args.pill;
    var label = args.label;
    var kind = args.kind;
    var envLabel = args.environmentLabel;
    var fetchFn = args.fetchFn;
    var now = args.now;
    var s;
    try {
      s = await fetchFn();
    } catch (err) {
      // fetchWithRetry already surfaces a console.warn before
      // resolving null; an exception thrown above that is genuinely
      // unexpected (JSON parse failure, etc) — log it and treat as
      // permanent failure for this tick.
      console.warn(
        "[deploy-status-pill] " +
          envLabel +
          " unexpected error: " +
          (err && err.message ? err.message : String(err)),
      );
      return null;
    }
    if (s === null) {
      // fetchWithRetry returned null — permanent failure for this tick.
      return null;
    }
    if (!s) {
      // No deployment found yet (the API returned an empty list).
      // Hide the pill and log a one-liner so devtools shows the
      // polling chain is alive even when the pill is invisible.
      console.info(
        "[deploy-status-pill] no deployment yet for " + envLabel + " — pill hidden, will re-poll.",
      );
      renderPill(pill, label, null, null);
      lastSeenStatusIds[kind] = null;
      lastSuccessfulPollAt[kind] = now;
      return true;
    }
    var statusId = s.status.id;
    if (statusId !== lastSeenStatusIds[kind]) {
      lastSeenStatusIds[kind] = statusId;
      renderPill(pill, label, s.status.state, s.status.log_url);
    }
    lastSuccessfulPollAt[kind] = now;
    return true;
  }

  // If the pill is currently visible AND it's been longer than
  // STALE_THRESHOLD_MS since we last had a successful poll, swap it
  // into the amber "(status stale — last poll <ago>)" view. Editors
  // get a visible signal that polling is broken instead of staring at
  // a frozen spinner that's secretly disconnected from reality.
  function applyStaleIfNeeded(pill, label, lastPollAt, now) {
    if (!isPillVisible(pill)) return;
    if (!lastPollAt) return; // never had a successful poll → nothing to mark stale
    if (now - lastPollAt < STALE_THRESHOLD_MS) return;
    renderStalePill(pill, label, lastPollAt, now);
  }

  // Decap re-renders the toolbar on entry switches and form mutations.
  // Re-attach the pills when the DOM changes; the polling tick takes
  // care of the actual content refresh.
  var observer;
  function watchToolbar() {
    if (observer) return;
    observer = new MutationObserver(function () {
      ensurePillInToolbar(PROD_PILL_ID);
      ensurePillInToolbar(PREVIEW_PILL_ID);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    watchToolbar();
    tick();
    setInterval(tick, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
