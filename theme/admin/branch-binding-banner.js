/*
 * admin/branch-binding-banner.js — says which branch this admin is bound to,
 * on every screen, whenever that is not the branch the site deploys to
 * production from (cms-platform#412).
 *
 * ── The defect ─────────────────────────────────────────────────────────
 * deploy-preview.yml patches the served admin/config.yml through
 * scripts/patch-preview-config.sh, so a preview's /admin is bound to the PR
 * branch: `backend.branch` is the PR head, `site_url` the preview host. That
 * is right — a preview admin editing the PR branch is the point. But the two
 * admins are byte-identical apart from that one config line, and an editor
 * arrives at the preview one routinely, via the link the preview bot posts on
 * every PR. So every string written for the production case is read verbatim
 * on a surface where it is false: "publish", "the site", "visible to the
 * public" all name the production site from a surface bound to a branch.
 * Measured on jodidaniel.com, 2026-09-04:
 *
 *   $ curl -s https://jodidaniel.com/admin/config.yml               | grep '^  branch:'
 *     branch: main
 *   $ curl -s https://preview-pr247.jodidaniel.com/admin/config.yml | grep '^  branch:'
 *     branch: claude/controls-gating-label-or72js
 *
 * Per-field copy cannot carry this. It is not a property of any field; it is
 * a property of the SURFACE. So it is stated once, here, at the top of every
 * screen — and only on the surface where it is true.
 *
 * ── Read from the config, never guessed from the hostname ──────────────
 * The verdict is `served backend.branch !== window.CMS_PRODUCTION_BRANCH`.
 *
 *   - The SERVED value is read from the same admin/config.yml Decap itself
 *     loads (fetched relative to this document, past the HTTP cache), at the
 *     line anchor patch-preview-config.sh WRITES: `^  branch:`. The reader
 *     mirrors the writer, and e2e/branch-binding-banner.test.js runs the real
 *     script on the real template and feeds its output to this parser, so the
 *     two cannot drift apart unnoticed. It is a lexical read of one leaf
 *     token, the same narrow contract site-gate-banner.js uses for its flag:
 *     a value that is not a plain git ref name matches nothing, and an
 *     unmatched value shows NO banner rather than a guessed one.
 *   - The PRODUCTION value is injected by both render paths as
 *     `window.CMS_PRODUCTION_BRANCH`, read with a real YAML parser off the
 *     config they rendered at BUILD time — before any preview patch. "Which
 *     branch is production" is site identity, and the platform never
 *     hardcodes site identity (publish-progress.js derives the same fact from
 *     the PR's base repo); this file carries no branch name at all, and
 *     e2e/admin-publishing-ux.test.js asserts that it never grows one.
 *
 * A hostname test would be shorter, and would silently disable the banner the
 * day a preview host is renamed — the exact failure this shim exists to
 * remove. So this file never reads `location`, not for the verdict and not to
 * sharpen a link either (the lint forbids both, because the second use grows
 * into the first).
 *
 * ── Where a change made here actually goes ─────────────────────────────
 * Decap's editorial workflow branches off `backend.branch` and merges back
 * into it, so on a preview a Publish updates the PREVIEW, and reaches the
 * production site only when the pull request for that branch merges. Media
 * library uploads and deletes of published entries commit straight to that
 * branch, so they follow the same path. A saved draft (and any image added
 * inside it) changes nothing on the preview; after the merge GitHub retargets
 * its open cms/* PR to production's branch, where it waits as a draft. The
 * copy says exactly that, and names the pull request by its title, linked,
 * read from the GitHub API. When that read fails it falls back to "its pull
 * request", linked by its head branch: a GitHub search, the one link
 * derivable from the config alone.
 *
 * ── In flow, not fixed; first, not last ────────────────────────────────
 * Same placement rule as site-gate-banner.js: a block in normal flow at the
 * top of <body>, never a `position: fixed` overlay over Decap's own toolbar
 * (the #329 defect). It is inserted as body's first child, and
 * site-gate-banner.js inserts itself AFTER this banner when one is present,
 * so the two read in a fixed order — "you are on a branch", then "the public
 * site is gated" — whichever fetch resolves first.
 *
 * It renders before login, deliberately: the config is public and needs no
 * token, so an editor who follows a preview link sees which branch they are
 * about to edit before they authenticate into it.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__branchBindingBannerInstalled) return;
  window.__branchBindingBannerInstalled = true;

  var BANNER_ID = "cms-branch-binding-banner";
  var CONFIG_FILE = "config.yml";
  // The characters a plain git ref name is made of. Anything else — a quoted
  // value, whitespace, markup — is not a branch this shim will put on screen.
  var REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

  var production = window.CMS_PRODUCTION_BRANCH;
  if (typeof production !== "string" || !production) return; // not injected — inert

  // The served backend.branch, or null when the text does not carry exactly
  // the line shape the writer produces (see "Read from the config" above).
  function parseBranch(text) {
    var m = /^ {2}branch:[ \t]*([^\s#]+)[ \t]*(?:#.*)?$/m.exec(String(text || ""));
    if (!m || !REF_NAME.test(m[1])) return null;
    return m[1];
  }

  function servedBranch() {
    var url = new URL(CONFIG_FILE, document.baseURI).href;
    return fetch(url, { cache: "no-cache" })
      .then(function (res) {
        return res.ok ? res.text() : null;
      })
      .then(function (text) {
        return text === null ? null : parseBranch(text);
      })
      .catch(function () {
        return null;
      });
  }

  function pullRequestUrl(branch) {
    var repo = window.CMS_REPO;
    if (!repo) return null;
    return "https://github.com/" + repo + "/pulls?q=" + encodeURIComponent("is:pr head:" + branch);
  }

  // How cross-post.yml treats each network a site lists under
  // `cross_post.profiles` (injected as window.CMS_CROSS_POST). Substack has no
  // publish API, so that leg only prepares a draft to paste in by hand.
  var CROSS_POST_AUTO = { mastodon: "Mastodon", linkedin: "LinkedIn" };
  var CROSS_POST_DRAFT = { substack: "Substack" };

  function joinNames(names) {
    if (names.length < 2) return names.join("");
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  // The sentence naming what merging also sends out, or "" when the site
  // cross-posts nowhere (or the list was not injected).
  function crossPostSentence() {
    var keys = Array.isArray(window.CMS_CROSS_POST) ? window.CMS_CROSS_POST : [];
    var auto = [];
    var drafts = [];
    keys.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(CROSS_POST_AUTO, k)) auto.push(CROSS_POST_AUTO[k]);
      else if (Object.prototype.hasOwnProperty.call(CROSS_POST_DRAFT, k)) drafts.push(CROSS_POST_DRAFT[k]);
    });
    if (!auto.length && !drafts.length) return "";
    var parts = [];
    if (auto.length) parts.push("posted to " + joinNames(auto));
    if (drafts.length) parts.push("made into a " + joinNames(drafts) + " draft for you to paste in");
    return " On merge, each new post published here is also " + parts.join(", and ") + ".";
  }

  // The open pull request for `branch`, as { title, url }, or null. The
  // editor's Decap token is sent when they are signed in; a public repo
  // answers without one. Any failure falls back to the search link above.
  function openPullRequest(branch) {
    var repo = window.CMS_REPO;
    if (!repo) return Promise.resolve(null);
    var owner = repo.split("/")[0];
    var headers = { Accept: "application/vnd.github+json" };
    var token = decapToken();
    if (token) headers.Authorization = "token " + token;
    var url =
      "https://api.github.com/repos/" + repo + "/pulls?state=open&per_page=1&head=" +
      encodeURIComponent(owner + ":" + branch);
    return fetch(url, { cache: "no-cache", headers: headers })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (list) {
        var pr = Array.isArray(list) ? list[0] : null;
        if (!pr || typeof pr.title !== "string" || !pr.title) return null;
        var href = String(pr.html_url || "");
        if (href.indexOf("https://github.com/") !== 0) return null;
        return { title: pr.title, url: href };
      })
      .catch(function () {
        return null;
      });
  }

  function decapToken() {
    try {
      var raw = localStorage.getItem("decap-cms-user");
      var p = raw ? JSON.parse(raw) : null;
      return p && p.token ? p.token : null;
    } catch {
      return null;
    }
  }

  function productionSite() {
    return window.CMSHostname ? window.CMSHostname.canonical() : "the published destination";
  }

  function render(branch, pr) {
    var existing = document.getElementById(BANNER_ID);
    // No readable branch → say nothing rather than guess. The production
    // branch → nothing to say.
    if (branch === null || branch === production) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return; // permanent while it applies — never re-created
    if (!document.body) return;

    var b = document.createElement("div");
    b.id = BANNER_ID;
    b.setAttribute("role", "status");
    // UI chrome, not page content — excluded from the visual-regression text
    // diff, like every other injected admin surface.
    b.setAttribute("data-visreg-ignore", "");
    b.style.cssText =
      [
        // NO position:fixed — see the placement block in the header.
        "box-sizing:border-box",
        "width:100%",
        "padding:0.7rem 1.1rem",
        "background:#0b2f5e",
        "color:#dbe9ff",
        "font:600 0.85rem/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
        "display:flex",
        "flex-wrap:wrap",
        "align-items:center",
        "gap:0.5rem 0.9rem",
      ].join(";") + ";";

    var text = document.createElement("span");
    text.style.cssText = "flex:1 1 20rem;min-width:14rem;font-weight:500;";
    text.appendChild(document.createTextNode("You are editing the "));
    var code = document.createElement("code");
    code.textContent = branch;
    code.style.cssText =
      "font:600 0.85em ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "padding:0.05rem 0.35rem;border-radius:3px;background:rgba(255,255,255,0.14);word-break:break-all;";
    text.appendChild(code);
    // This banner identifies the preview tab the editor opened. Publication
    // copy uses destination(); this tab's identity intentionally uses current().
    text.appendChild(
      document.createTextNode(
        " branch on " + (window.CMSHostname ? window.CMSHostname.current() : "this preview") +
          ". New or changed entries you publish, Media library uploads and deleted " +
          "published entries update this preview only, and reach " + productionSite() + " when ",
      ),
    );
    // The pull request by its own title, so the editor can tell what it is
    // without following the link; the head-branch search when the title could
    // not be read.
    var href = pr ? pr.url : pullRequestUrl(branch);
    if (href) {
      var a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = pr ? "\u201c" + pr.title + "\u201d" : "its pull request";
      a.style.cssText = "color:#dbe9ff;font-weight:700;text-decoration:underline;";
      text.appendChild(a);
    } else {
      text.appendChild(document.createTextNode("its pull request"));
    }
    // A saved draft changes nothing on the preview. When the pull request
    // merges, GitHub retargets its open cms/* drafts to the merged PR's base,
    // so they become drafts in the production admin.
    text.appendChild(
      document.createTextNode(
        " merges. Drafts, and images added to them, become drafts on " + productionSite() + "." +
          crossPostSentence(),
      ),
    );
    b.appendChild(text);

    document.body.insertBefore(b, document.body.firstChild);
    // Make room: Decap's entry editor is an absolute box anchored to the
    // viewport and would paint over a block in flow at body's top. The class
    // keys admin-notice-band.css, which is inert until a banner is on screen.
    document.body.classList.add("cms-notice-band");
  }

  function refresh() {
    return servedBranch().then(function (branch) {
      if (branch === null || branch === production) return render(branch, null);
      return openPullRequest(branch).then(function (pr) {
        render(branch, pr);
      });
    });
  }

  // The binding a served config names does not change under a page, so one
  // read per load is the whole budget — no interval, no observer.
  function start() {
    refresh();
  }

  // Exported for e2e/branch-binding-banner.test.js (vm sandbox), the same
  // seam publish-progress.js exposes as window.CMSPublishProgress.
  window.CMSBranchBinding = { refresh: refresh, parseBranch: parseBranch, BANNER_ID: BANNER_ID };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
