/*
 * admin/media-search.js — the "Media search" page (/admin/media-search.html).
 *
 * The weekly media search writes its finds to a data file on a results
 * branch. This page lets the site owner decide, find by find, whether it
 * belongs on the site. "Add to site" opens the SAME draft the website
 * editor's own "new entry" flow opens (so it shows up in the editor's
 * Workflow list); "Not for the site" only records the decision.
 *
 * ── Shape ──────────────────────────────────────────────────────────────
 * Everything that decides something is a pure function on `MediaSearch`
 * (dates, link safety, grouping, merging decisions, building the draft
 * requests) and is unit-tested in e2e/media-search.test.js. `createApi`
 * wraps GitHub's REST API around an injected `fetch`, so the tests run it
 * against a fake. The DOM code at the bottom only runs on the page itself
 * (it needs #ms-app) and builds every node with createElement/textContent:
 * the finds come from the open web and are untrusted, so no data ever goes
 * through innerHTML.
 *
 * ── Sign-in ────────────────────────────────────────────────────────────
 * Reuses the website editor's session (localStorage `decap-cms-user`,
 * `.token`), sent as `Authorization: token …` like reviews/index.html. No
 * token, or a 401, means "please sign in to the website editor first".
 *
 * ── The draft ──────────────────────────────────────────────────────────
 * Mirrors scripts/media_discovery/github_api.py `open_entry_pr` and
 * render.py `render_pr`: branch cms/<collection>/<slug> from the production
 * branch head, the entry file committed on it, a pull request to the
 * production branch titled `Create Media “slug”` (or Events), labels
 * decap-cms/pending_review + media-discovery, and the dedupe marker
 * `<!-- media-discovery:v1 url=… -->` on the body's first line.
 * `normalizeUrl` and `safeMd` are ports of domains.py `normalize_url` and
 * render.py `safe_md`; e2e/media-search.test.js pins them to values the
 * Python produced.
 */
(function () {
  "use strict";

  // ── Where the data lives ─────────────────────────────────────────────
  // The ONE place to change if the results move (for example to a separate
  // private data repository).
  var DATA_SOURCE = {
    repo: (typeof window !== "undefined" && window.CMS_REPO) || "",
    branch: "persistent/media-search",
    findingsPath: "findings.json",
    decisionsPath: "decisions.json",
  };
  // The draft's production branch: the site's configured one, else the
  // repository's default branch (what the weekly search itself uses).
  var PRODUCTION_BRANCH = (typeof window !== "undefined" && window.CMS_PRODUCTION_BRANCH) || "";
  var DRAFT_LABELS = ["decap-cms/pending_review", "media-discovery"];
  var TOKEN_STORAGE_KEY = "decap-cms-user";
  var API = "https://api.github.com";
  var EDITOR_PATH = "/admin/";

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  var KIND_LABELS = {
    upcoming_talk: "Upcoming talk",
    past_talk: "Talk or panel",
    podcast: "Podcast or interview",
    press: "In the press",
    authored_article: "Article you wrote",
    brief_testimony: "Report or testimony",
  };

  // ── Dates ────────────────────────────────────────────────────────────
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(s || "").trim());
    if (!m) return null;
    var month = Number(m[2]);
    var day = m[3] === undefined ? null : Number(m[3]);
    if (month < 1 || month > 12) return null;
    if (day !== null && (day < 1 || day > 31)) return null;
    return { year: Number(m[1]), month: month, day: day };
  }

  // "2026-03-24" -> "March 24, 2026"; "2026-03" -> "March 2026"; else "".
  function formatDate(s) {
    var d = parseDate(s);
    if (!d) return "";
    if (d.day === null) return MONTHS[d.month - 1] + " " + d.year;
    return MONTHS[d.month - 1] + " " + d.day + ", " + d.year;
  }

  // A start and an optional end, the way the site shows an event's dates.
  function formatDateRange(start, end) {
    var a = parseDate(start);
    var b = parseDate(end);
    if (!a) return "";
    if (!b || a.day === null || b.day === null || String(end) <= String(start)) return formatDate(start);
    var mon = function (d) { return MONTHS[d.month - 1]; };
    if (a.year === b.year && a.month === b.month) return mon(a) + " " + a.day + " – " + b.day + ", " + a.year;
    if (a.year === b.year) return mon(a) + " " + a.day + " – " + mon(b) + " " + b.day + ", " + a.year;
    return formatDate(start) + " – " + formatDate(end);
  }

  // An ISO time such as 2026-11-10T13:00:00Z. Only the calendar date is
  // shown, read from the text so the viewer's time zone cannot move it.
  function formatTimestamp(iso) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ""));
    return m ? formatDate(m[1]) : "";
  }

  // ── Links ────────────────────────────────────────────────────────────
  // The href to render for an untrusted URL, or null when it is not a plain
  // http(s) link (javascript:, data:, relative text, and so on).
  function safeUrl(u) {
    if (typeof u !== "string" || !u.trim()) return null;
    var parsed;
    try {
      parsed = new URL(u.trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  }

  // ── Findings and decisions ───────────────────────────────────────────
  function emptyDecisions() {
    return { version: 1, decisions: {} };
  }

  function normalizeDecisions(doc) {
    var out = emptyDecisions();
    if (doc && typeof doc === "object" && doc.decisions && typeof doc.decisions === "object") {
      Object.keys(doc.decisions).forEach(function (id) {
        var rec = doc.decisions[id];
        if (rec && (rec.decision === "added" || rec.decision === "skipped")) out.decisions[id] = rec;
      });
    }
    return out;
  }

  function mergeDecision(doc, id, record) {
    var out = normalizeDecisions(doc);
    out.decisions[id] = record;
    return out;
  }

  function removeDecision(doc, id) {
    var out = normalizeDecisions(doc);
    delete out.decisions[id];
    return out;
  }

  function byDateDesc(a, b) {
    var x = String(a.date || "");
    var y = String(b.date || "");
    if (x !== y) return x < y ? 1 : -1;
    return String(a.title || "").localeCompare(String(b.title || ""));
  }

  // Undecided finds first-class: ready-to-add ones before the "worth a look"
  // ones, newest first within each. The two done lists are newest decision
  // first. A decision about a find that is no longer in the results is
  // ignored.
  function groupFindings(findings, decisionsDoc) {
    var decisions = normalizeDecisions(decisionsDoc).decisions;
    var fresh = [];
    var added = [];
    var skipped = [];
    (Array.isArray(findings) ? findings : []).forEach(function (f) {
      if (!f || typeof f.id !== "string") return;
      var rec = decisions[f.id];
      if (!rec) fresh.push(f);
      else if (rec.decision === "added") added.push({ finding: f, record: rec });
      else skipped.push({ finding: f, record: rec });
    });
    var rank = function (f) { return f.status === "confirmed" ? 0 : 1; };
    fresh.sort(function (a, b) { return rank(a) - rank(b) || byDateDesc(a, b); });
    var byAt = function (a, b) {
      var x = String(a.record.at || "");
      var y = String(b.record.at || "");
      return x === y ? byDateDesc(a.finding, b.finding) : x < y ? 1 : -1;
    };
    added.sort(byAt);
    skipped.sort(byAt);
    return { fresh: fresh, added: added, skipped: skipped };
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || "Mention";
  }

  // ── Text for a pull request body (ports of render.py) ────────────────
  var WORD_JOINER = "⁠";

  // One line, no control or format characters, capped (render.py _clean).
  function cleanText(s, cap) {
    var out = "";
    var str = String(s == null ? "" : s);
    for (var ch of str) {
      if (/[\p{Cc}\p{Cf}]/u.test(ch)) {
        if (ch === "\n" || ch === "\r" || ch === "\t") out += " ";
        continue;
      }
      out += /[\p{Zl}\p{Zp}]/u.test(ch) ? " " : ch;
    }
    out = out.split(/\s+/).filter(Boolean).join(" ");
    return Array.from(out).slice(0, cap).join("").replace(/\s+$/, "");
  }

  // Backslash-escape every ASCII punctuation character and keep GitHub from
  // turning text into mentions, issue references or autolinks (render.py
  // safe_md has the reasoning).
  function safeMd(s, cap) {
    var text = cleanText(s, cap == null ? 600 : cap);
    text = text.replace(/@/g, "@" + WORD_JOINER);
    text = text.replace(/(#|gh-)(?=\d)/gi, function (m) { return m + WORD_JOINER; });
    text = text.split("://").join(":/" + WORD_JOINER + "/");
    return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
  }

  function mdLink(url) {
    var href = safeUrl(url);
    if (!href) return safeMd(url);
    return "<" + percentEncode(href, ":/?#[]@!$&'()*+,;=%-._~") + ">";
  }

  // ── URL normalization (port of domains.py normalize_url) ─────────────
  var PATH_SAFE = "/%:@!$&'()*+,;=~-._";
  var TRACKING_PARAMS = { fbclid: true, gclid: true };

  // Python's urllib.parse.quote: UTF-8 bytes, everything but letters,
  // digits, "_.-~" and `safe` becomes %XX.
  function percentEncode(str, safe) {
    var bytes = new TextEncoder().encode(String(str));
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var c = String.fromCharCode(bytes[i]);
      if (/[A-Za-z0-9_.\-~]/.test(c) || (bytes[i] < 128 && safe.indexOf(c) !== -1)) out += c;
      else out += "%" + (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16).toUpperCase();
    }
    return out;
  }

  function percentDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  // The dedupe key the weekly search stores in a draft's body. Throws on a
  // URL that is not http(s), like the Python.
  function normalizeUrl(url) {
    var m = /^([A-Za-z][A-Za-z0-9+.\-]*):\/\/([^\/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(String(url).trim());
    var scheme = m ? m[1].toLowerCase() : "";
    if (scheme !== "http" && scheme !== "https") throw new Error("only http(s) URLs are allowed");
    var netloc = m[2].slice(m[2].lastIndexOf("@") + 1);
    var host = netloc;
    var port = null;
    var pm = /^(\[[^\]]*\]|[^:]*):(\d*)$/.exec(netloc);
    if (pm) {
      host = pm[1];
      port = pm[2] === "" ? null : Number(pm[2]);
    }
    host = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (host.indexOf("www.") === 0) host = host.slice(4);
    if (!host) throw new Error("no host in URL");
    var defaultPort = scheme === "https" ? 443 : 80;
    var authority = port === null || port === defaultPort ? host : host + ":" + port;
    var pairs = [];
    String(m[4] || "").split("&").forEach(function (part) {
      if (!part) return;
      var eq = part.indexOf("=");
      var k = percentDecode((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
      var v = eq < 0 ? "" : percentDecode(part.slice(eq + 1).replace(/\+/g, " "));
      var lk = k.toLowerCase();
      if (lk.indexOf("utm_") === 0 || TRACKING_PARAMS[lk]) return;
      pairs.push([k, v]);
    });
    pairs.sort(function (a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    });
    var plus = function (s) { return percentEncode(s, "").replace(/%20/g, "+"); };
    var query = pairs.map(function (p) { return plus(p[0]) + "=" + plus(p[1]); }).join("&");
    var path = percentEncode(m[3], PATH_SAFE).replace(/\/+$/, "") || "/";
    return scheme + "://" + authority + path + (query ? "?" + query : "");
  }

  function prMarker(url) {
    return "<!-- media-discovery:v1 url=" + normalizeUrl(url) + " -->";
  }

  // ── Building the draft's requests ────────────────────────────────────
  function draftBranch(entry) {
    return "cms/" + entry.collection + "/" + entry.slug;
  }

  function editorEntryPath(entry) {
    return EDITOR_PATH + "#/collections/" + encodeURIComponent(entry.collection) + "/entries/" +
      encodeURIComponent(entry.slug);
  }

  function draftTitle(entry) {
    return "Create " + (entry.collection === "media" ? "Media" : "Events") + " “" + entry.slug + "”";
  }

  function toBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromBase64(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function draftBody(finding, adminUrl) {
    var lines = [
      prMarker(finding.primary_url),
      "",
      "## TLDR",
      "",
      "Found by the weekly media search and added from the Media search page: " + safeMd(finding.title, 300) +
        ", " + safeMd(finding.outlet, 300) + ", " + safeMd(finding.date, 300) +
        ". Publish it in /admin to add it to the site, or delete it there to reject it.",
      "",
      "## Sources",
      "",
      "- " + mdLink(finding.primary_url),
    ];
    (finding.other_urls || []).forEach(function (u) {
      if (safeUrl(u)) lines.push("- " + mdLink(u));
    });
    lines.push("", "Review and publish: " + mdLink(adminUrl), "");
    return lines.join("\n");
  }

  // The four writes that make the draft, as data. `baseSha` is the
  // production branch's head commit.
  function buildDraftRequests(finding, baseBranch, baseSha, adminUrl) {
    var entry = finding.entry;
    var branch = draftBranch(entry);
    var title = draftTitle(entry);
    return {
      branch: branch,
      ref: { ref: "refs/heads/" + branch, sha: baseSha },
      file: { message: title, branch: branch, content: toBase64(entry.content) },
      pull: { title: title, body: draftBody(finding, adminUrl), head: branch, base: baseBranch },
      labels: { labels: DRAFT_LABELS.slice() },
    };
  }

  // ── Sign-in ──────────────────────────────────────────────────────────
  function readToken(storage) {
    try {
      var raw = storage && storage.getItem(TOKEN_STORAGE_KEY);
      var user = raw ? JSON.parse(raw) : null;
      return user && typeof user.token === "string" && user.token ? user.token : "";
    } catch (e) {
      return "";
    }
  }

  // ── GitHub ───────────────────────────────────────────────────────────
  // Thrown for any answer that is not a success. `status` 401 means the
  // editor's sign-in has lapsed; the page never shows `message` to the owner
  // (it is plain English for the tests and the console).
  function ApiError(status, what) {
    this.name = "ApiError";
    this.status = status;
    this.message = what + " (" + status + ")";
  }
  ApiError.prototype = Object.create(Error.prototype);

  function pathOf(p) {
    return String(p).split("/").map(encodeURIComponent).join("/");
  }

  function createApi(opts) {
    var doFetch = opts.fetch;
    var token = opts.token;
    var source = opts.source || DATA_SOURCE;
    var repo = source.repo;
    var base = API + "/repos/" + repo.split("/").map(encodeURIComponent).join("/");
    var adminOrigin = opts.adminOrigin || "";
    var prodBranch = opts.productionBranch || "";

    async function call(method, url, body, accept) {
      var init = {
        method: method,
        cache: "no-store",
        headers: {
          Authorization: "token " + token,
          Accept: accept || "application/vnd.github+json",
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] = "application/json";
      }
      var res;
      try {
        res = await doFetch(url, init);
      } catch (e) {
        throw new ApiError(0, method + " failed");
      }
      return res;
    }

    async function json(res) {
      try {
        return await res.json();
      } catch (e) {
        return null;
      }
    }

    function must(res, what, okStatuses) {
      if ((okStatuses || [200, 201]).indexOf(res.status) === -1) throw new ApiError(res.status, what);
    }

    // { data, sha } for a JSON file on the data branch, or { data: null,
    // sha: null } when it does not exist yet.
    async function readFile(path) {
      var url = base + "/contents/" + pathOf(path) + "?ref=" + encodeURIComponent(source.branch);
      var res = await call("GET", url);
      if (res.status === 404) return { data: null, sha: null };
      must(res, "read " + path, [200]);
      var meta = await json(res);
      var text;
      if (meta && meta.encoding === "base64" && typeof meta.content === "string") {
        text = fromBase64(meta.content);
      } else {
        // Larger than the contents endpoint inlines: ask for the raw text.
        var raw = await call("GET", url, undefined, "application/vnd.github.raw+json");
        must(raw, "read " + path, [200]);
        text = await raw.text();
      }
      try {
        return { data: JSON.parse(text), sha: meta && meta.sha ? meta.sha : null };
      } catch (e) {
        throw new ApiError(0, path + " is not readable");
      }
    }

    async function readFindings() {
      var file = await readFile(source.findingsPath);
      var d = file.data;
      if (!d || !Array.isArray(d.findings)) return null;
      return { searchedAt: d.searched_at || "", findings: d.findings };
    }

    async function readDecisions() {
      var file = await readFile(source.decisionsPath);
      return { doc: normalizeDecisions(file.data), sha: file.sha };
    }

    // GET the file for its sha, apply `change`, PUT. A stale sha (409/422)
    // re-reads and re-applies the change once; the result is the document
    // that was written.
    async function updateDecisions(change, message) {
      for (var attempt = 0; attempt < 2; attempt++) {
        var current = await readDecisions();
        var next = change(current.doc);
        var body = {
          message: message,
          branch: source.branch,
          content: toBase64(JSON.stringify(next, null, 2) + "\n"),
        };
        if (current.sha) body.sha = current.sha;
        var res = await call("PUT", base + "/contents/" + pathOf(source.decisionsPath), body);
        if ((res.status === 409 || res.status === 422) && attempt === 0) continue;
        must(res, "save decisions", [200, 201]);
        return next;
      }
      throw new ApiError(409, "save decisions");
    }

    function recordDecision(finding, decision, by, now, draft) {
      var record = { decision: decision, at: now, by: by || "" };
      if (draft) record.draft = draft;
      return updateDecisions(function (doc) {
        return mergeDecision(doc, finding.id, record);
      }, (decision === "added" ? "Added: " : "Skipped: ") + finding.id);
    }

    function undoDecision(finding) {
      return updateDecisions(function (doc) {
        return removeDecision(doc, finding.id);
      }, "Put back: " + finding.id);
    }

    async function productionBranch() {
      if (prodBranch) return prodBranch;
      var res = await call("GET", base);
      must(res, "read site", [200]);
      var info = await json(res);
      if (!info || !info.default_branch) throw new ApiError(0, "site has no main branch");
      prodBranch = info.default_branch;
      return prodBranch;
    }

    // The draft for one find. Resolves { draft: {number, branch}, already }.
    // A draft branch that already exists means an earlier run or the editor
    // got there first: it is reported as already added, never overwritten.
    async function openDraft(finding) {
      var entry = finding.entry;
      var branchName = await productionBranch();
      var headRes = await call("GET", base + "/git/ref/heads/" + pathOf(branchName));
      must(headRes, "read site", [200]);
      var head = await json(headRes);
      var reqs = buildDraftRequests(finding, branchName, head && head.object && head.object.sha,
        adminOrigin + editorEntryPath(entry));

      var refRes = await call("POST", base + "/git/refs", reqs.ref);
      must(refRes, "create draft", [201, 422]);
      var existed = refRes.status === 422;
      if (existed) {
        var found = await findDraftPull(reqs.branch);
        if (found) return { draft: { number: found, branch: reqs.branch }, already: true };
      }

      var putRes = await call("PUT", base + "/contents/" + pathOf(entry.path), reqs.file);
      must(putRes, "save draft", [200, 201, 422]);
      if (putRes.status === 422 && !existed) {
        // The entry is already on the live site. Remove the empty branch.
        await call("DELETE", base + "/git/refs/heads/" + pathOf(reqs.branch));
        return { draft: null, already: true };
      }

      var prRes = await call("POST", base + "/pulls", reqs.pull);
      must(prRes, "open draft", [201]);
      var pr = await json(prRes);
      var number = pr && pr.number;
      var labelRes = await call("POST", base + "/issues/" + number + "/labels", reqs.labels);
      must(labelRes, "label draft", [200, 201]);
      return { draft: { number: number, branch: reqs.branch }, already: false };
    }

    async function findDraftPull(branch) {
      var owner = repo.split("/")[0];
      var res = await call("GET", base + "/pulls?state=all&head=" + encodeURIComponent(owner + ":" + branch));
      if (res.status !== 200) return null;
      var list = await json(res);
      return Array.isArray(list) && list.length && list[0].number ? list[0].number : null;
    }

    async function currentUser() {
      var res = await call("GET", API + "/user");
      must(res, "check sign-in", [200]);
      var user = await json(res);
      return user && user.login ? String(user.login) : "";
    }

    return {
      readFindings: readFindings,
      readDecisions: readDecisions,
      currentUser: currentUser,
      openDraft: openDraft,
      recordDecision: recordDecision,
      undoDecision: undoDecision,
    };
  }

  var api = {
    DATA_SOURCE: DATA_SOURCE,
    DRAFT_LABELS: DRAFT_LABELS,
    ApiError: ApiError,
    formatDate: formatDate,
    formatDateRange: formatDateRange,
    formatTimestamp: formatTimestamp,
    safeUrl: safeUrl,
    normalizeDecisions: normalizeDecisions,
    mergeDecision: mergeDecision,
    removeDecision: removeDecision,
    groupFindings: groupFindings,
    kindLabel: kindLabel,
    safeMd: safeMd,
    normalizeUrl: normalizeUrl,
    prMarker: prMarker,
    draftBranch: draftBranch,
    draftTitle: draftTitle,
    editorEntryPath: editorEntryPath,
    draftBody: draftBody,
    buildDraftRequests: buildDraftRequests,
    readToken: readToken,
    createApi: createApi,
  };
  if (typeof window !== "undefined") window.MediaSearch = api;

  // ═══ The page ═══════════════════════════════════════════════════════
  // Below this line is DOM only. It runs just on /admin/media-search.html.
  if (typeof document === "undefined" || !document.getElementById("ms-app")) return;

  var root = document.getElementById("ms-app");
  var state = {
    api: null,
    login: "",
    findings: [],
    searchedAt: "",
    decisions: emptyDecisions(),
    tab: "new",
    busy: {},
    message: null,
  };
  // Decision writes go one at a time, so two quick taps cannot race.
  var queue = Promise.resolve();

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(kid);
    });
    return node;
  }

  function extLink(url, text, cls) {
    var href = safeUrl(url);
    if (!href) return null;
    return el("a", { href: href, target: "_blank", rel: "noopener noreferrer", class: cls || "ms-link", text: text });
  }

  function button(text, cls, onClick, label) {
    var b = el("button", { type: "button", class: "ms-btn " + cls, text: text });
    if (label) b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function reducedMotion() {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function say(text, link) {
    state.message = text ? { text: text, link: link || null } : null;
    var box = document.getElementById("ms-status");
    box.textContent = "";
    if (!state.message) return;
    box.appendChild(document.createTextNode(text));
    if (link) {
      box.appendChild(document.createTextNode(" "));
      box.appendChild(el("a", { href: link.href, class: "ms-link", text: link.text }));
    }
  }

  function showScreen(name) {
    ["ms-signin", "ms-loading", "ms-problem", "ms-main"].forEach(function (id) {
      document.getElementById(id).hidden = id !== name;
    });
  }

  function showProblem(text) {
    document.getElementById("ms-problem-text").textContent = text;
    showScreen("ms-problem");
  }

  function failure(err) {
    if (err && err.status === 401) {
      showScreen("ms-signin");
      return;
    }
    say("That didn't work. Nothing was changed. Please try again in a moment.");
  }

  // ── Cards ────────────────────────────────────────────────────────────
  function whenLine(f) {
    var parts = [f.outlet, formatDateRange(f.date, f.end_date)].filter(Boolean);
    return parts.join(" · ");
  }

  function cardHead(f, badgeText, badgeClass) {
    return el("div", { class: "ms-card-head" }, [
      el("p", { class: "ms-kind", text: kindLabel(f.kind) }),
      el("span", { class: "ms-badge " + badgeClass, text: badgeText }),
    ]);
  }

  function reasonList(f) {
    var items = (f.reasons || []).filter(function (r) { return r && r.text; }).map(function (r) {
      var li = el("li", { text: r.text });
      if (!r.main) {
        var open = extLink(r.url, "Open that page");
        if (open) {
          li.appendChild(document.createTextNode(" "));
          li.appendChild(open);
        }
      }
      return li;
    });
    if (!items.length) return null;
    return el("div", { class: "ms-why" }, [
      el("p", { class: "ms-why-title", text: "Why we're not sure" }),
      el("ul", {}, items),
    ]);
  }

  function newCard(f) {
    var sure = f.status === "confirmed";
    var busy = !!state.busy[f.id];
    var card = el("article", { class: "ms-card", "data-id": f.id });
    card.appendChild(cardHead(f, sure ? "Ready to add" : "Worth a look", sure ? "ms-ok" : "ms-look"));
    card.appendChild(el("h3", { class: "ms-title", text: f.title || "Untitled" }));
    card.appendChild(el("p", { class: "ms-when", text: whenLine(f) }));
    var open = extLink(f.primary_url, "Open the page");
    if (open) card.appendChild(el("p", { class: "ms-open" }, [open]));
    if (!sure) card.appendChild(reasonList(f));
    var addBtn = button(busy ? "Adding…" : sure ? "Add to site" : "It's me — add it", "ms-primary",
      function () { decide(f, "added", card); });
    var skipBtn = button(sure ? "Not for the site" : "Not me / skip", "ms-secondary",
      function () { decide(f, "skipped", card); });
    addBtn.disabled = skipBtn.disabled = busy;
    card.appendChild(el("div", { class: "ms-actions" }, [addBtn, skipBtn]));
    return card;
  }

  function editorLink(f) {
    if (!f.entry) return null;
    return el("a", { href: editorEntryPath(f.entry), class: "ms-link", text: "Open in the website editor" });
  }

  function doneCard(item, skipped) {
    var f = item.finding;
    var when = formatTimestamp(item.record.at);
    var card = el("article", { class: "ms-card ms-done", "data-id": f.id });
    card.appendChild(el("h3", { class: "ms-title", text: f.title || "Untitled" }));
    card.appendChild(el("p", { class: "ms-when", text: whenLine(f) }));
    card.appendChild(el("p", { class: "ms-when", text: (skipped ? "Skipped" : "Added as a draft") + (when ? " on " + when : "") }));
    if (skipped) {
      var busy = !!state.busy[f.id];
      var undo = button(busy ? "Putting back…" : "Undo", "ms-secondary", function () { undoSkip(f); },
        "Undo: put " + (f.title || "this find") + " back in New");
      undo.disabled = busy;
      card.appendChild(el("div", { class: "ms-actions" }, [undo]));
    } else {
      var link = editorLink(f);
      if (link) card.appendChild(el("p", { class: "ms-open" }, [link]));
    }
    return card;
  }

  // ── Page ─────────────────────────────────────────────────────────────
  function render() {
    var groups = groupFindings(state.findings, state.decisions);
    var counts = { new: groups.fresh.length, added: groups.added.length, skipped: groups.skipped.length };
    var searched = formatTimestamp(state.searchedAt);
    document.getElementById("ms-searched").textContent = searched ? "Last searched " + searched : "";

    var tabs = document.getElementById("ms-tabs");
    tabs.textContent = "";
    [["new", "New"], ["added", "Added"], ["skipped", "Skipped"]].forEach(function (t) {
      var b = el("button", { type: "button", class: "ms-tab", "aria-pressed": String(state.tab === t[0]) }, [
        document.createTextNode(t[1] + " "),
        el("span", { class: "ms-count", text: String(counts[t[0]]) }),
      ]);
      b.addEventListener("click", function () {
        state.tab = t[0];
        render();
      });
      tabs.appendChild(b);
    });

    var list = document.getElementById("ms-list");
    list.textContent = "";
    var items;
    var empty;
    if (state.tab === "new") {
      items = groups.fresh.map(newCard);
      empty = ["You're all caught up.", "The next search runs Monday."];
    } else if (state.tab === "added") {
      items = groups.added.map(function (i) { return doneCard(i, false); });
      empty = ["Nothing added yet.", "Finds you add will be listed here."];
    } else {
      items = groups.skipped.map(function (i) { return doneCard(i, true); });
      empty = ["Nothing skipped.", "Finds you skip will be listed here, in case you change your mind."];
    }
    if (!items.length) {
      list.appendChild(el("div", { class: "ms-empty" }, [
        el("p", { class: "ms-empty-title", text: empty[0] }),
        el("p", { class: "ms-empty-text", text: empty[1] }),
      ]));
    }
    items.forEach(function (c) { list.appendChild(c); });
  }

  // Slide the card away, then redraw without it.
  function leave(card) {
    if (!card || reducedMotion()) {
      render();
      return;
    }
    var finished = false;
    var done = function () {
      if (finished) return;
      finished = true;
      render();
    };
    card.style.maxHeight = card.offsetHeight + "px";
    void card.offsetHeight;
    card.classList.add("ms-leaving");
    card.addEventListener("transitionend", function (e) {
      if (e.target === card && e.propertyName === "max-height") done();
    });
    setTimeout(done, 700);
  }

  function enqueue(task) {
    var run = queue.then(task, task);
    queue = run.catch(function () {});
    return run;
  }

  function decide(f, decision, card) {
    if (state.busy[f.id]) return;
    state.busy[f.id] = true;
    say("");
    render();
    var cardNow = function () { return document.querySelector('[data-id="' + f.id + '"]'); };
    enqueue(async function () {
      try {
        var draft = null;
        var already = false;
        if (decision === "added") {
          var opened = await state.api.openDraft(f);
          draft = opened.draft;
          already = opened.already;
        }
        state.decisions = await state.api.recordDecision(f, decision, state.login, new Date().toISOString(), draft);
        delete state.busy[f.id];
        if (decision === "added") {
          say((already ? "That one was already added. " : "Added as a draft. ") +
            "Review and publish it in the website editor.",
          f.entry ? { href: editorEntryPath(f.entry), text: "Open it in the website editor" } : null);
        } else {
          say("Skipped. You can undo this on the Skipped tab.");
        }
        leave(cardNow());
      } catch (err) {
        delete state.busy[f.id];
        render();
        failure(err);
      }
    });
  }

  function undoSkip(f) {
    if (state.busy[f.id]) return;
    state.busy[f.id] = true;
    say("");
    render();
    enqueue(async function () {
      try {
        state.decisions = await state.api.undoDecision(f);
        delete state.busy[f.id];
        say("Put back in New.");
        leave(document.querySelector('[data-id="' + f.id + '"]'));
      } catch (err) {
        delete state.busy[f.id];
        render();
        failure(err);
      }
    });
  }

  async function load() {
    showScreen("ms-loading");
    var token = readToken(window.localStorage);
    if (!token) {
      showScreen("ms-signin");
      return;
    }
    state.api = createApi({
      fetch: window.fetch.bind(window),
      token: token,
      adminOrigin: window.location.origin,
      productionBranch: PRODUCTION_BRANCH,
    });
    try {
      state.login = await state.api.currentUser();
      var results = await state.api.readFindings();
      var decided = await state.api.readDecisions();
      state.decisions = decided.doc;
      state.findings = results ? results.findings : [];
      state.searchedAt = results ? results.searchedAt : "";
      showScreen("ms-main");
      render();
    } catch (err) {
      if (err && err.status === 401) showScreen("ms-signin");
      else showProblem("We couldn't load the search results just now. Please try again in a moment.");
    }
  }

  document.getElementById("ms-retry").addEventListener("click", load);
  load();
})();
