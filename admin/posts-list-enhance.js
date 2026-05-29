/*
 * admin/posts-list-enhance.js — turns Decap's bare Posts collection
 * list into an at-a-glance dashboard, and hides the E2E-canary noise
 * by default. Issue #1042 ("Improve admin UI related to posts").
 *
 * Decap 3.12.2's list view renders one `<li>` per entry containing a
 * single `<a href="#/collections/posts/entries/<slug>">` whose only
 * child is an `<h2>` holding the `summary:` string. There is no
 * supported `window`/Redux path to the entries' frontmatter, and the
 * `summary:` template is a single plain-text line — no columns, no
 * links. This script therefore AUGMENTS the native cards in place
 * (it never replaces the `<a>`, so every existing e2e selector
 * `a[href*="#/collections/posts/entries/"]` keeps working) and adds:
 *
 *   - a status pill (Published / Draft / Scheduled), derived from the
 *     summary text the `summary:` template already encodes;
 *   - a one-click "published ↗" link to the live post URL (computed
 *     from the slug, mirroring admin/live-url-derive.js's math);
 *   - "edited <ago>" — the last commit that touched the post's file
 *     on `main`, plus the PR that commit was merged in (one batched
 *     GitHub GraphQL query, `history` + `associatedPullRequests`, for
 *     every visible post);
 *   - "view published changes" — the GitHub diff (Files-changed tab)
 *     of that merged PR. Shown only when the post is actually live on
 *     `main` (an unpublished draft has no merged PR, so it is omitted
 *     there); rendered BEFORE "preview draft" when both are present;
 *   - "preview draft ↗" — the per-PR preview environment for the
 *     post's open editorial-workflow PR, if any (GitHub REST, one
 *     `pulls` call) — `https://preview-pr<N>.adamdaniel.ai/blog/<slug>/`;
 *   - "view draft changes" — the GitHub diff (Files-changed tab) of
 *     that same open editorial-workflow PR;
 *   - a control bar showing when the site itself last deployed
 *     (GitHub REST, one `deployments` call) plus a manual ↻ Refresh.
 *
 * Batched remote data (the three calls above, never one-per-row) is
 * cached in sessionStorage and refreshed (a) on the ↻ button and
 * (b) every time the user navigates back to the list from an entry
 * (issue #1042: "Update when returning to post list from edit post").
 * Auth reuses the operator's Decap token at
 * localStorage["decap-cms-user"].token (same pattern as
 * admin/deploy-status-pill.js). With no token / on any API error the
 * remote columns are simply omitted — the local columns still render.
 *
 * ── Automated-test fixtures ──────────────────────────────────────
 * The E2E canary posts (_posts/*-e2e-*.md, `test_fixture: true`) are
 * hidden BY DEFAULT (issue #1042: the new "Automated tests" Filter-by
 * entry "default to not checked, pre-existing options checked").
 * Decap 3.12.2 has no declarative default for `view_filters`, so the
 * default-off behaviour lives here. The hide is NON-DESTRUCTIVE: the
 * fixture `<li>`s are moved to the END of the list and then
 * collapsed, so a spec that clicks `a[href*="…/entries/"]`.first()
 * (cms-smoke, manual-walkthrough-contributor) still lands on a
 * VISIBLE real post rather than a hidden fixture. A "Show
 * automated-test posts (N)" toggle (state persisted in localStorage)
 * reveals them. Specs that need a canary navigate to it directly by
 * URL — the deterministic pattern this repo already prefers (see
 * cms-unpublish-republish.spec.js).
 *
 * ── Quick add ────────────────────────────────────────────────────
 * The `_e2e` collection is `create: true` (test-locked — UI-driven
 * CRUD specs depend on the `#/collections/e2e/new` route), which makes
 * Decap list "E2E Canary" in the header Quick-add menu (and the
 * `[E2E TEST FIXTURES …]` item on the /workflow board). Decap has no
 * config to drop a creatable collection from Quick-add only, so this
 * script CSS-hides just that menu item when the menu opens. The
 * `#/collections/e2e/new` route is untouched, so the seed specs and
 * `e2e/canary-content.test.js` (which asserts `create: true`) stay
 * green.
 *
 * Robustness: same shape as admin/deploy-status-pill.js /
 * native-preview-href.js — a single IIFE, a rAF-debounced
 * MutationObserver on document.body, idempotent re-application on
 * Decap's React re-renders, every external call wrapped so a failure
 * degrades instead of throwing into Decap.
 *
 * Test contract: e2e/cms-posts-list-enhance.spec.js (static, @lane
 * local) locks the load wiring + fixture-detection contract; the
 * existing cms-smoke / manual-walkthrough specs exercise that the
 * native card anchors still resolve with this script active.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__postsListEnhanceInstalled) return;
  window.__postsListEnhanceInstalled = true;

  var REPO = window.CMS_REPO;
  var REST = "https://api.github.com/repos/" + REPO;
  var GQL = "https://api.github.com/graphql";
  var SITE_ORIGIN = window.CMS_SITE_ORIGIN;
  var SHOW_FIXTURES_KEY = "cms-ple-show-fixtures";
  var CACHE_KEY = "cms-ple-remote-cache-v1";
  var CACHE_TTL_MS = 5 * 60 * 1000;
  var MAX_GQL_FILES = 60;

  // A post is an automated-test fixture if its on-disk slug looks like
  // a dated e2e canary (`YYYY-MM-DD-e2e-…`) or its title leads with
  // "E2E ". This mirrors the `test_fixture: true` frontmatter the
  // canary _posts now carry (which the `Automated tests` view_filter
  // keys off) — but the list DOM exposes no frontmatter, so detection
  // here is slug/title-based and survives a harness run that
  // momentarily rewrites a canary's frontmatter.
  var FIXTURE_SLUG_RE = /^\d{4}-\d{2}-\d{2}-e2e-/i;
  var FIXTURE_TITLE_RE = /^\s*E2E\s/i;

  // ── small helpers ────────────────────────────────────────────────
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

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isPostsListRoute() {
    var h = window.location.hash || "";
    return (
      /^#\/collections\/posts\/?$/.test(h) ||
      /^#\/collections\/posts\/filter\//.test(h) ||
      /^#\/collections\/posts\/search\//.test(h)
    );
  }

  // url slug = on-disk slug minus Jekyll's `YYYY-MM-DD-` _posts prefix,
  // THEN run through Jekyll's slugify. `permalink: /blog/:slug/` strips the
  // date prefix AND passes the result through `Jekyll::Utils.slugify`
  // (lowercase + collapse non-[a-z0-9] runs to single `-` + trim). Posts
  // created through Decap arrive pre-slugified, but a post committed outside
  // Decap (e.g. the `2026-05-28-quoting-anthropic-opus-4-8-safety-"somewhat-
  // less-robust".md` content post, #1815) keeps its raw punctuation in the
  // filename; date-stripping alone produced a `published ↗` link with the
  // curly quotes that 404s, because the live URL drops them. Reuse the SINGLE
  // slugify owned by admin/live-url-derive.js (loaded first, `defer`, so
  // `window.LiveURL` is always defined here — same load-order contract
  // live-url-banner.js relies on). The cross-runtime twin in
  // e2e/public-content.js is drift-locked to it by e2e/slugify-parity.test.js.
  function urlSlug(fileSlug) {
    var dateStripped = String(fileSlug || "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    var L = window.LiveURL;
    return L && L.slugify ? L.slugify(dateStripped) : dateStripped;
  }

  function publicUrl(fileSlug) {
    var s = urlSlug(fileSlug);
    return s ? SITE_ORIGIN + "/blog/" + s + "/" : null;
  }

  // The summary template is
  //   "{{title}} ({{year}}-{{month}}-{{day}}){{… — DRAFT}}{{… — Scheduled}}"
  // so the rendered card text already encodes the state.
  function stateFromSummary(text) {
    var t = String(text || "");
    var scheduled = /—\s*Scheduled\b/.test(t);
    var draft = /—\s*DRAFT\b/.test(t);
    if (scheduled) return { label: "Scheduled", color: "#9a6700", live: false };
    if (draft) return { label: "Draft", color: "#57606a", live: false };
    return { label: "Published", color: "#1a7f37", live: true };
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    var mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.round(hrs / 24);
    if (days < 30) return days + "d ago";
    var mos = Math.round(days / 30);
    return mos < 12 ? mos + "mo ago" : Math.round(mos / 12) + "y ago";
  }

  // ── card discovery ───────────────────────────────────────────────
  function collectCards() {
    var anchors = document.querySelectorAll('a[href*="#/collections/posts/entries/"]');
    var cards = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var m = /#\/collections\/posts\/entries\/([^?#]+)/.exec(a.getAttribute("href") || "");
      if (!m) continue;
      var slug;
      try {
        slug = decodeURIComponent(m[1]);
      } catch {
        slug = m[1];
      }
      var li = a.closest("li") || a.parentElement;
      var h2 = a.querySelector("h2");
      var summaryText = (h2 ? h2.textContent : a.textContent || "").trim();
      var title = summaryText.replace(/\s*\(.*$/, "").trim() || slug;
      var isFixture = FIXTURE_SLUG_RE.test(slug) || FIXTURE_TITLE_RE.test(title);
      cards.push({
        a: a,
        li: li,
        slug: slug,
        filePath: "_posts/" + slug + ".md",
        title: title,
        summaryText: summaryText,
        state: stateFromSummary(summaryText),
        isFixture: isFixture,
      });
    }
    return cards;
  }

  // ── remote (batched) ─────────────────────────────────────────────
  // Three calls TOTAL regardless of post count:
  //   1. GraphQL — last commit on main for every visible post file.
  //   2. REST    — latest `production` deployment (site last-deployed).
  //   3. REST    — open PRs, to map a post slug → its editorial PR.
  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || Date.now() - c.at > CACHE_TTL_MS) return null;
      return c;
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch {
      /* sessionStorage full / disabled — in-memory only */
    }
  }

  var memCache = null;

  async function safeJson(res) {
    if (!res || !res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchLastEdited(token, cards) {
    var files = [];
    var seen = Object.create(null);
    for (var i = 0; i < cards.length && files.length < MAX_GQL_FILES; i++) {
      var fp = cards[i].filePath;
      if (seen[fp]) continue;
      seen[fp] = true;
      files.push(fp);
    }
    if (!files.length) return {};
    var parts = files.map(function (fp, idx) {
      return (
        "f" +
        idx +
        ": history(first: 1, path: " +
        JSON.stringify(fp) +
        ") { nodes { committedDate url" +
        " associatedPullRequests(first: 1) { nodes { number url } } } }"
      );
    });
    var query =
      "query {\n  repository(owner: " +
      JSON.stringify(REPO.split("/")[0]) +
      ", name: " +
      JSON.stringify(REPO.split("/")[1]) +
      ') {\n    ref(qualifiedName: "refs/heads/main") {\n      target {\n        ... on Commit {\n          ' +
      parts.join("\n          ") +
      "\n        }\n      }\n    }\n  }\n}";
    var out = {};
    try {
      var res = await fetch(GQL, {
        method: "POST",
        headers: {
          Authorization: "bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: query }),
      });
      var j = await safeJson(res);
      var commit =
        j && j.data && j.data.repository && j.data.repository.ref && j.data.repository.ref.target
          ? j.data.repository.ref.target
          : null;
      if (commit) {
        files.forEach(function (fp, idx) {
          var node = commit["f" + idx] && commit["f" + idx].nodes && commit["f" + idx].nodes[0];
          if (!node) return;
          // associatedPullRequests(first:1) on the last main commit =
          // the PR whose merge published the current live version of
          // this file. GraphQL `PullRequest.url` is the html URL
          // (https://github.com/<repo>/pull/<n>); appending `/files`
          // in decorate() yields its Files-changed diff.
          var prNode =
            node.associatedPullRequests &&
            node.associatedPullRequests.nodes &&
            node.associatedPullRequests.nodes[0];
          out[fp] = {
            date: node.committedDate,
            url: node.url,
            pr: prNode ? { number: prNode.number, url: prNode.url } : null,
          };
        });
      }
    } catch (e) {
      console.warn(
        "[posts-list-enhance] last-edited query failed: " + (e && e.message ? e.message : e),
      );
    }
    return out;
  }

  async function fetchSiteDeploy(token) {
    try {
      var dRes = await fetch(REST + "/deployments?environment=production&per_page=1", {
        headers: {
          Authorization: "token " + token,
          Accept: "application/vnd.github+json",
        },
      });
      var deps = await safeJson(dRes);
      if (!Array.isArray(deps) || !deps.length) return null;
      var sRes = await fetch(REST + "/deployments/" + deps[0].id + "/statuses?per_page=1", {
        headers: {
          Authorization: "token " + token,
          Accept: "application/vnd.github+json",
        },
      });
      var st = await safeJson(sRes);
      if (!Array.isArray(st) || !st.length) return null;
      return {
        state: st[0].state,
        at: st[0].created_at,
        url: st[0].log_url || st[0].target_url || null,
      };
    } catch {
      return null;
    }
  }

  async function fetchOpenPrBySlug(token) {
    var map = {};
    try {
      var res = await fetch(REST + "/pulls?state=open&per_page=100", {
        headers: {
          Authorization: "token " + token,
          Accept: "application/vnd.github+json",
        },
      });
      var prs = await safeJson(res);
      if (!Array.isArray(prs)) return map;
      prs.forEach(function (pr) {
        var ref = (pr.head && pr.head.ref) || "";
        // Decap editorial-workflow branches: cms/posts/<slug> (the
        // slug here is the on-disk file slug). Be lenient: any open
        // PR whose head ref ends with a posts file slug.
        var mm = /(?:^|\/)((?:\d{4}-\d{2}-\d{2}-)?[a-z0-9-]+)$/i.exec(ref);
        if (/cms\/posts\//i.test(ref) && mm) {
          map[mm[1]] = { number: pr.number, url: pr.html_url };
        }
      });
    } catch {
      /* degrade */
    }
    return map;
  }

  async function refreshRemote(cards) {
    var token = getToken();
    if (!token) return null;
    var lastEdited = await fetchLastEdited(token, cards);
    var siteDeploy = await fetchSiteDeploy(token);
    var prBySlug = await fetchOpenPrBySlug(token);
    var data = {
      lastEdited: lastEdited,
      siteDeploy: siteDeploy,
      prBySlug: prBySlug,
    };
    memCache = data;
    writeCache(data);
    return data;
  }

  // ── rendering ────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById("cms-ple-style")) return;
    var s = document.createElement("style");
    s.id = "cms-ple-style";
    s.textContent = [
      ".cms-ple-meta{display:flex;flex-wrap:wrap;gap:0.5rem 0.9rem;",
      "align-items:center;margin:0.35rem 0 0;font-size:0.72rem;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
      "color:#57606a;}",
      ".cms-ple-pill{display:inline-block;padding:0.05rem 0.45rem;",
      "border-radius:999px;font-weight:600;font-size:0.66rem;",
      "letter-spacing:0.02em;color:#fff;}",
      ".cms-ple-meta a{color:#0969da;text-decoration:none;}",
      ".cms-ple-meta a:hover{text-decoration:underline;}",
      ".cms-ple-fixture-tag{color:#8250df;font-weight:600;}",
      "#cms-ple-bar{display:flex;flex-wrap:wrap;align-items:center;",
      "gap:0.75rem;margin:0 0 0.6rem;padding:0.5rem 0.7rem;",
      "border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
      "font-size:0.74rem;color:#57606a;}",
      "#cms-ple-bar button{font:inherit;cursor:pointer;color:#0969da;",
      "background:none;border:1px solid #d0d7de;border-radius:5px;",
      "padding:0.2rem 0.55rem;}",
      "#cms-ple-bar button:hover{border-color:#0969da;}",
      "#cms-ple-bar label{display:flex;align-items:center;gap:0.3rem;",
      "cursor:pointer;}",
      "body.cms-ple-hide-fixtures li[data-cms-ple-fixture='1']",
      "{display:none !important;}",
    ].join("");
    document.head.appendChild(s);
  }

  function showFixtures() {
    try {
      return localStorage.getItem(SHOW_FIXTURES_KEY) === "1";
    } catch {
      return false;
    }
  }

  function applyHideClass() {
    document.body.classList.toggle("cms-ple-hide-fixtures", !showFixtures());
  }

  function listUl(cards) {
    for (var i = 0; i < cards.length; i++) {
      var ul = cards[i].li && cards[i].li.closest("ul");
      if (ul) return ul;
    }
    return null;
  }

  // Cache the last-rendered bar HTML and only rewrite when changed.
  // Without this guard the document.body MutationObserver fires on every
  // `bar.innerHTML = …` write, schedules another augment(), which writes
  // identical HTML again — a self-sustaining ~60 Hz re-parse loop that
  // detaches the checkbox / Refresh button mid-tap on iOS Safari so the
  // synthesized click lands on a disconnected element (issue: posts
  // list looked read-only — taps did nothing). Same pattern decorate()
  // below and live-url-banner.js use.
  var lastBarHTML = null;

  function ensureBar(cards, fixtureCount) {
    var ul = listUl(cards);
    if (!ul || !ul.parentNode) return;
    var bar = document.getElementById("cms-ple-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "cms-ple-bar";
      ul.parentNode.insertBefore(bar, ul);
      lastBarHTML = null;
    } else if (bar.nextElementSibling !== ul && bar.parentNode === ul.parentNode) {
      ul.parentNode.insertBefore(bar, ul);
    }
    var deploy =
      (memCache && memCache.siteDeploy) ||
      (readCache() && readCache().data && readCache().data.siteDeploy);
    var deployHtml = deploy
      ? "site " +
        (deploy.state === "success" ? "deployed" : esc(deploy.state)) +
        " " +
        esc(timeAgo(deploy.at)) +
        (deploy.url
          ? ' · <a href="' + esc(deploy.url) + '" target="_blank" rel="noopener">run ↗</a>'
          : "")
      : '<span style="color:#8c959f">sign in for deploy / PR data</span>';
    var nextHTML =
      '<strong style="color:#24292f">Posts</strong>' +
      '<label title="The E2E canary fixtures are hidden by default. ' +
      'Specs that need them navigate by direct URL.">' +
      '<input type="checkbox" id="cms-ple-show-fixtures"' +
      (showFixtures() ? " checked" : "") +
      " /> Show automated-test posts (" +
      fixtureCount +
      ")</label>" +
      '<button type="button" id="cms-ple-refresh" title="Re-fetch ' +
      'last-edited / PR / deploy data">↻ Refresh</button>' +
      '<span id="cms-ple-deploy">' +
      deployHtml +
      "</span>";
    if (nextHTML !== lastBarHTML) {
      // eslint-disable-next-line no-unsanitized/property -- every dynamic value in `nextHTML` (deploy state/url/age) is run through the HTML-escaping `esc()` helper; the rest is static markup.
      bar.innerHTML = nextHTML;
      lastBarHTML = nextHTML;
    }

    var cb = bar.querySelector("#cms-ple-show-fixtures");
    if (cb && !cb.__wired) {
      cb.__wired = true;
      cb.addEventListener("change", function () {
        try {
          localStorage.setItem(SHOW_FIXTURES_KEY, cb.checked ? "1" : "0");
        } catch {
          /* ignore */
        }
        applyHideClass();
      });
    }
    var rb = bar.querySelector("#cms-ple-refresh");
    if (rb && !rb.__wired) {
      rb.__wired = true;
      rb.addEventListener("click", function () {
        rb.disabled = true;
        rb.textContent = "↻ …";
        refreshRemote(collectCards())
          .catch(function () {})
          .then(function () {
            rb.disabled = false;
            rb.textContent = "↻ Refresh";
            // Invalidate the bar cache so the next augment() repaints
            // the deploy/PR spans with the freshly-fetched data even if
            // the rest of the HTML hash happens to match.
            lastBarHTML = null;
            scheduleAugment();
          });
      });
    }
  }

  function decorate(card, remote) {
    var li = card.li;
    if (!li) return;
    var meta = li.querySelector(":scope > .cms-ple-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "cms-ple-meta";
      li.appendChild(meta);
    }
    var bits = [];
    bits.push(
      '<span class="cms-ple-pill" style="background:' +
        card.state.color +
        '">' +
        esc(card.state.label) +
        "</span>",
    );
    if (card.isFixture) {
      bits.push('<span class="cms-ple-fixture-tag">automated test</span>');
    }
    var pub = publicUrl(card.slug);
    if (pub && card.state.live) {
      bits.push(
        '<a href="' +
          esc(pub) +
          '" target="_blank" rel="noopener" ' +
          'title="Open the published post">published ↗</a>',
      );
    } else if (pub) {
      bits.push(
        '<span title="Live once published" style="color:#8c959f">' +
          esc("/blog/" + urlSlug(card.slug) + "/") +
          "</span>",
      );
    }
    var le = remote && remote.lastEdited && remote.lastEdited[card.filePath];
    if (le && le.date) {
      bits.push(
        '<span title="Last commit to ' +
          esc(card.filePath) +
          ' on main">edited ' +
          (le.url
            ? '<a href="' +
              esc(le.url) +
              '" target="_blank" ' +
              'rel="noopener">' +
              esc(timeAgo(le.date)) +
              "</a>"
            : esc(timeAgo(le.date))) +
          "</span>",
      );
    }
    // "view published changes" — the GitHub diff (Files-changed tab)
    // of the PR whose merge put the current live version of this post
    // on the production site (`le.pr`, the PR associated with the last
    // commit to the file on `main`; see fetchLastEdited). Visibility:
    //   - unpublished draft (never merged → no `main` history → no
    //     `le.pr`): omitted — nothing has been published yet;
    //   - published, no open draft: shown;
    //   - published + open draft changes: shown, and — because this
    //     block precedes the open-PR block below — it renders BEFORE
    //     "preview draft".
    // The merged-PR-on-`main` signal is deliberately used instead of
    // the frontmatter `published` flag the summary encodes: a post can
    // carry `published: true` while still sitting in an unmerged
    // editorial PR (not on production at all — the same mismatch the
    // live-url-banner preview fix addresses), so "does a merged PR for
    // this file exist on main" is the accurate "is it live" test.
    var publishedPr = le && le.pr;
    if (publishedPr) {
      bits.push(
        '<a href="' +
          esc(publishedPr.url) +
          '/files" target="_blank" rel="noopener" title="GitHub diff ' +
          "(Files changed) of the merged PR #" +
          esc(publishedPr.number) +
          ' that published the live version">view published changes</a>',
      );
    }

    var pr =
      remote &&
      remote.prBySlug &&
      (remote.prBySlug[card.slug] || remote.prBySlug[urlSlug(card.slug)]);
    if (pr) {
      bits.push(
        '<a href="https://preview-pr' +
          esc(pr.number) +
          "." + window.CMS_APEX + "/blog/" +
          esc(urlSlug(card.slug)) +
          '/" target="_blank" rel="noopener" title="Per-PR preview ' +
          "environment for the unmerged draft (open PR #" +
          esc(pr.number) +
          ')">preview draft ↗</a>',
      );
      bits.push(
        '<a href="' +
          esc(pr.url) +
          '/files" target="_blank" rel="noopener" title="GitHub diff ' +
          "(Files changed) of the open editorial-workflow PR #" +
          esc(pr.number) +
          '">view draft changes</a>',
      );
    }
    var next = bits.join("");
    // eslint-disable-next-line no-unsanitized/property -- every dynamic value pushed into `bits` (PR numbers, URLs, slugs, timestamps) is run through the HTML-escaping `esc()` helper; the rest is static markup.
    if (meta.innerHTML !== next) meta.innerHTML = next;
  }

  // Move fixture rows to the END of the list (still in the DOM, still
  // navigable by direct URL) so that with fixtures hidden the FIRST
  // `a[href*="…/entries/"]` is a visible real post — the contract
  // cms-smoke / manual-walkthrough-contributor rely on.
  function reorderFixturesLast(cards) {
    var ul = listUl(cards);
    if (!ul) return;
    // Tag fixtures (and untag former ones), collecting them in list order.
    var fixtureLis = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c.li) continue;
      if (c.isFixture) {
        c.li.setAttribute("data-cms-ple-fixture", "1");
        fixtureLis.push(c.li);
      } else if (c.li.getAttribute("data-cms-ple-fixture") === "1") {
        c.li.removeAttribute("data-cms-ple-fixture");
      }
    }
    // Idempotency guard — only mutate when the fixtures are NOT already a
    // contiguous tail (i.e. some non-fixture <li> still follows a fixture).
    // The earlier "append every fixture whose li !== lastElementChild"
    // form never reached a fixed point with ≥2 fixtures: it moved the
    // second-to-last fixture to last on every pass, swapping the final two
    // forever. Each move mutated the list, re-firing the document.body
    // MutationObserver → scheduleAugment() → reorderFixturesLast() again, a
    // ~60 Hz reorder/reflow loop that pegged the main thread (worst at the
    // 3K admin viewport, where Decap never settled and the post-login
    // sidebar links never became visible within the e2e step budget).
    var kids = ul.children;
    var seenFixture = false;
    var settled = true;
    for (var k = 0; k < kids.length; k++) {
      var isFixtureLi =
        kids[k].getAttribute && kids[k].getAttribute("data-cms-ple-fixture") === "1";
      if (isFixtureLi) {
        seenFixture = true;
      } else if (seenFixture) {
        settled = false;
        break;
      }
    }
    if (settled) return;
    for (var j = 0; j < fixtureLis.length; j++) ul.appendChild(fixtureLis[j]);
  }

  // ── Quick-add: hide the E2E item only ────────────────────────────
  function hideE2EQuickAdd() {
    var items = document.querySelectorAll('[role="menuitem"]');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var txt = (el.textContent || "").trim();
      // Header Quick-add uses label_singular ("E2E Canary"); the
      // /workflow board "New Post" menu uses the collection label
      // ("[E2E TEST FIXTURES — DO NOT EDIT]"). Match either, and
      // nothing else (Post / Tag / Project / Page / the Filter-by
      // items are untouched).
      if (txt === "E2E Canary" || /E2E TEST FIXTURES/i.test(txt)) {
        el.style.setProperty("display", "none", "important");
      }
    }
  }

  // ── orchestration ────────────────────────────────────────────────
  var pending = false;
  function scheduleAugment() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      try {
        augment();
      } catch (e) {
        console.warn("[posts-list-enhance] augment error: " + (e && e.message ? e.message : e));
      }
    });
  }

  function augment() {
    hideE2EQuickAdd();
    if (!isPostsListRoute()) return;
    var cards = collectCards();
    if (!cards.length) return;
    ensureStyle();
    applyHideClass();

    var remote = memCache || (readCache() ? readCache().data : null);

    var fixtureCount = 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].isFixture) fixtureCount++;
      decorate(cards[i], remote);
    }
    reorderFixturesLast(cards);
    ensureBar(cards, fixtureCount);
  }

  // First land on the list (incl. returning from an entry editor):
  // refresh the batched remote data, per issue #1042 ("Update when
  // returning to post list from edit post").
  var lastWasList = false;
  function onRoute() {
    var nowList = isPostsListRoute();
    if (nowList && !lastWasList) {
      // entered the list — kick a remote refresh, then re-render.
      refreshRemote(collectCards())
        .catch(function () {})
        .then(scheduleAugment);
    }
    lastWasList = nowList;
    scheduleAugment();
  }

  // Synchronous fixture-reorder pre-pass: runs inside the
  // MutationObserver callback BEFORE the rAF-debounced full augment.
  // Without this, Decap's React renders the entries list, our
  // scheduleAugment queues an rAF, and there's a ~16 ms window where
  // a fixture `<li>` sits at the head of the list — long enough for
  // an e2e spec doing `a[href*="…/entries/"]`.first().click() to
  // resolve to (and try to click) a CSS-hidden fixture anchor. The
  // reorder is idempotent — `c.li !== ul.lastElementChild` short-
  // circuits, so an already-correct order produces no DOM mutation
  // and no observer re-fire. Full augment (decorate, ensureBar) keeps
  // its rAF debounce.
  function syncFixtureReorder() {
    if (!isPostsListRoute()) return;
    var cards = collectCards();
    if (cards.length) reorderFixturesLast(cards);
  }

  window.addEventListener("hashchange", onRoute);
  new MutationObserver(function () {
    try {
      syncFixtureReorder();
    } catch {
      /* swallow — never let our hook block Decap's own updates */
    }
    scheduleAugment();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onRoute, { once: true });
  } else {
    onRoute();
  }
})();
