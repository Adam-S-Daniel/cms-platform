// @lane: local — pure-Node unit test for theme/admin/media-search.js (vm sandbox, fake fetch, no network).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = path.resolve(__dirname, "../theme/admin/media-search.js");

function load() {
  const sandbox = {
    window: { CMS_REPO: "owner/site", CMS_PRODUCTION_BRANCH: "main" },
    URL,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    encodeURIComponent,
    decodeURIComponent,
    Uint8Array,
    Promise,
    JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  return sandbox.window.MediaSearch;
}
const MS = load();
const plain = (v) => JSON.parse(JSON.stringify(v));
const rejection = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const FINDING = {
  id: "f1",
  status: "confirmed",
  kind: "past_talk",
  title: "Health Policy Academy",
  outlet: "Alliance",
  date: "2026-03-24",
  end_date: null,
  primary_url: "https://www.example.com/a/?utm_source=x",
  other_urls: ["https://example.net/b", "javascript:alert(1)"],
  reasons: [],
  entry: {
    collection: "media",
    slug: "1-health-policy-academy",
    path: "_media/1-health-policy-academy.md",
    content: '---\ntitle: "Café"\n---\n',
  },
};

test.describe("media-search: dates", () => {
  test("formats full dates, months, ranges and timestamps", () => {
    expect(MS.formatDate("2026-03-24")).toBe("March 24, 2026");
    expect(MS.formatDate("2026-03")).toBe("March 2026");
    expect(MS.formatDate("2026-13-01")).toBe("");
    expect(MS.formatDate("soon")).toBe("");
    expect(MS.formatDate(null)).toBe("");
    expect(MS.formatDateRange("2026-03-24", "2026-03-26")).toBe("March 24 – 26, 2026");
    expect(MS.formatDateRange("2026-03-24", "2026-04-02")).toBe("March 24 – April 2, 2026");
    expect(MS.formatDateRange("2026-03-24", null)).toBe("March 24, 2026");
    expect(MS.formatTimestamp("2026-11-10T13:00:00Z")).toBe("November 10, 2026");
    expect(MS.formatTimestamp("")).toBe("");
  });
});

test.describe("media-search: safe links", () => {
  test("only http and https links survive", () => {
    expect(MS.safeUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(MS.safeUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//example.com", "example.com", "", null, "ftp://x.org", " JaVaScRiPt:1"]) {
      expect(MS.safeUrl(bad), String(bad)).toBeNull();
    }
  });
});

test.describe("media-search: grouping and decisions", () => {
  const mk = (id, status, date, title) => ({ id, status, date, title: title || id, kind: "press" });
  const findings = [
    mk("a", "unconfirmed", "2026-06-01"),
    mk("b", "confirmed", "2026-01-01"),
    mk("c", "confirmed", "2026-03"),
    mk("d", "unconfirmed", "2026-07-01"),
    mk("e", "confirmed", "2026-02-01"),
    mk("f", "confirmed", "2026-02-02"),
  ];
  const doc = {
    version: 1,
    decisions: {
      e: { decision: "skipped", at: "2026-11-01T10:00:00Z", by: "jodi" },
      f: { decision: "added", at: "2026-11-02T10:00:00Z", by: "jodi", draft: { number: 5, branch: "cms/media/x" } },
      gone: { decision: "skipped", at: "2026-11-03T10:00:00Z", by: "jodi" },
      weird: { decision: "maybe" },
    },
  };

  test("undecided first: ready-to-add before worth-a-look, newest first", () => {
    const g = MS.groupFindings(findings, doc);
    expect(g.fresh.map((f) => f.id)).toEqual(["c", "b", "d", "a"]);
    expect(g.added.map((i) => i.finding.id)).toEqual(["f"]);
    expect(g.skipped.map((i) => i.finding.id)).toEqual(["e"]);
  });

  test("handles missing data", () => {
    expect(plain(MS.groupFindings(undefined, null))).toEqual({ fresh: [], added: [], skipped: [] });
  });

  test("merging and undoing never mutate the input", () => {
    const before = JSON.stringify(doc);
    const merged = MS.mergeDecision(doc, "a", { decision: "skipped", at: "t", by: "j" });
    expect(merged.decisions.a.decision).toBe("skipped");
    expect(merged.decisions.e.decision).toBe("skipped");
    expect(merged.decisions.weird).toBeUndefined();
    expect(merged.version).toBe(1);
    const undone = MS.removeDecision(merged, "a");
    expect(undone.decisions.a).toBeUndefined();
    expect(JSON.stringify(doc)).toBe(before);
    expect(plain(MS.mergeDecision(null, "x", { decision: "added" }))).toEqual({
      version: 1,
      decisions: { x: { decision: "added" } },
    });
  });
});

test.describe("media-search: URL normalization matches normalize_url in domains.py", () => {
  // Expected values were produced by scripts/media_discovery/domains.py.
  const cases = [
    ["https://WWW.Example.com:443/a/b/?utm_x=1&b=2&a=3&fbclid=z#frag", "https://example.com/a/b?a=3&b=2"],
    ["http://example.com:8080", "http://example.com:8080/"],
    ["https://example.com/Café é/x%20y/?q=a+b&q=a%26c&z", "https://example.com/Caf%C3%A9%20%C3%A9/x%20y?q=a+b&q=a%26c&z="],
    ["https://user:pw@news.example.org./p//", "https://news.example.org/p"],
    ["http://example.com/a?x", "http://example.com/a?x="],
    ["https://example.com/p?a=1&a=0&A=2", "https://example.com/p?A=2&a=0&a=1"],
  ];
  for (const [input, expected] of cases) {
    test(input, () => expect(MS.normalizeUrl(input)).toBe(expected));
  }
  test("refuses non-http(s)", () => {
    expect(() => MS.normalizeUrl("javascript:alert(1)")).toThrow();
    expect(() => MS.normalizeUrl("ftp://example.com/")).toThrow();
  });
});

test.describe("media-search: draft payloads mirror open_entry_pr and render_pr", () => {
  const r = MS.buildDraftRequests(FINDING, "main", "abc123", "https://site.test/admin/#/x");

  test("branch, ref and file", () => {
    expect(r.branch).toBe("cms/media/1-health-policy-academy");
    expect(plain(r.ref)).toEqual({ ref: "refs/heads/cms/media/1-health-policy-academy", sha: "abc123" });
    expect(r.file.branch).toBe(r.branch);
    expect(r.file.message).toBe("Create Media “1-health-policy-academy”");
    expect(Buffer.from(r.file.content, "base64").toString("utf8")).toBe(FINDING.entry.content);
  });

  test("pull request title, base, labels and marker first", () => {
    expect(r.pull.title).toBe("Create Media “1-health-policy-academy”");
    expect(r.pull.head).toBe(r.branch);
    expect(r.pull.base).toBe("main");
    expect(plain(r.labels)).toEqual({ labels: ["decap-cms/pending_review", "media-discovery"] });
    expect(r.pull.body.split("\n")[0]).toBe("<!-- media-discovery:v1 url=https://example.com/a -->");
    expect(r.pull.body.startsWith("<!-- media-discovery:v1 url=")).toBe(true);
    expect(r.pull.body).toContain("## TLDR");
    expect(r.pull.body).not.toContain("javascript:");
    expect(r.pull.body).toContain("<https://example.net/b>");
  });

  test("events get the Events title and editor path", () => {
    const e = { collection: "events", slug: "2026-05-01-x", path: "_events/x.md", content: "" };
    expect(MS.draftTitle(e)).toBe("Create Events “2026-05-01-x”");
    expect(MS.editorEntryPath(e)).toBe("/admin/#/collections/events/entries/2026-05-01-x");
  });

  test("untrusted text cannot start markup, mentions or references", () => {
    const out = MS.safeMd("<img src=x> @bob #12 [a](http://e.com) **x**\nline");
    expect(out).not.toMatch(/(^|[^\\])[<>\[\]*]/);
    expect(out).toContain("@⁠bob");
    expect(out).toContain("#⁠12");
    expect(out).not.toContain("\n");
  });
});

test.describe("media-search: sign-in token", () => {
  test("reads decap-cms-user and tolerates junk", () => {
    const store = (v) => ({ getItem: () => v });
    expect(MS.readToken(store(JSON.stringify({ token: "t0k" })))).toBe("t0k");
    expect(MS.readToken(store("not json"))).toBe("");
    expect(MS.readToken(store(null))).toBe("");
    expect(MS.readToken(store(JSON.stringify({ token: 5 })))).toBe("");
    expect(MS.readToken(null)).toBe("");
  });
});

// A tiny GitHub: files per path, refs, pulls; scripted failures by key.
function fakeGitHub(opts = {}) {
  const files = new Map(Object.entries(opts.files || {}));
  const calls = [];
  const shas = new Map();
  let n = 1;
  const refs = new Set(opts.refs || []);
  const failOnce = new Set(opts.failOnce || []);
  const res = (status, body) => ({
    status,
    ok: status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname.replace("/repos/owner/site", "")}`;
    calls.push({ key, init, search: u.search });
    expect(init.headers.Authorization).toBe("token T");
    expect(init.cache).toBe("no-store");
    const body = init.body ? JSON.parse(init.body) : null;
    if (failOnce.delete(key)) return res(422, {});
    if (key === "GET /user") return res(200, { login: "jodi" });
    if (key.startsWith("GET /contents/")) {
      const p = decodeURIComponent(u.pathname.split("/contents/")[1]);
      if (!files.has(p)) return res(404, {});
      return res(200, { encoding: "base64", content: b64(files.get(p)), sha: "sha-" + (shas.get(p) || 0) });
    }
    if (key.startsWith("PUT /contents/")) {
      const p = decodeURIComponent(u.pathname.split("/contents/")[1]);
      if (p === "decisions.json") {
        const have = files.has(p);
        if (have && body.sha !== "sha-" + (shas.get(p) || 0)) return res(409, {});
        if (!have && body.sha) return res(422, {});
        files.set(p, Buffer.from(body.content, "base64").toString("utf8"));
        shas.set(p, (shas.get(p) || 0) + 1);
        return res(200, {});
      }
      return res(opts.fileExistsOnMain ? 422 : 201, {});
    }
    if (key === "GET /git/ref/heads/main") return res(200, { object: { sha: "headsha" } });
    if (key === "POST /git/refs") {
      if (refs.has(body.ref)) return res(422, {});
      refs.add(body.ref);
      return res(201, {});
    }
    if (key === "GET /pulls") return res(200, opts.existingPull ? [{ number: 9 }] : []);
    if (key === "POST /pulls") return res(201, { number: 42 + n++ });
    if (key.startsWith("POST /issues/")) return res(200, []);
    if (key.startsWith("DELETE /git/refs/")) return res(204, null);
    return res(500, {});
  };
  return { fetch, calls, files, shas };
}

const apiFor = (gh) =>
  MS.createApi({ fetch: gh.fetch, token: "T", adminOrigin: "https://site.test", productionBranch: "main" });
const keys = (gh) => gh.calls.map((c) => c.key);

test.describe("media-search: GitHub flow with a fake fetch", () => {
  test("reads findings from the data branch (decoding UTF-8)", async () => {
    const gh = fakeGitHub({ files: { "findings.json": JSON.stringify({ version: 1, searched_at: "2026-11-10T13:00:00Z", findings: [{ id: "x", title: "Café" }] }) } });
    const got = await apiFor(gh).readFindings();
    expect(got.searchedAt).toBe("2026-11-10T13:00:00Z");
    expect(got.findings[0].title).toBe("Café");
    expect(gh.calls[0].search).toBe("?ref=persistent%2Fmedia-search");
  });

  test("missing files read as empty", async () => {
    const gh = fakeGitHub();
    const a = apiFor(gh);
    expect(await a.readFindings()).toBeNull();
    const d = await a.readDecisions();
    expect(plain(d)).toEqual({ doc: { version: 1, decisions: {} }, sha: null });
  });

  test("first decision creates decisions.json; later ones merge with the sha", async () => {
    const gh = fakeGitHub();
    const a = apiFor(gh);
    await a.recordDecision(FINDING, "skipped", "jodi", "2026-11-10T14:00:00Z");
    await a.recordDecision({ id: "f2" }, "added", "jodi", "2026-11-10T15:00:00Z", { number: 7, branch: "cms/media/y" });
    const saved = JSON.parse(gh.files.get("decisions.json"));
    expect(saved.decisions.f1).toEqual({ decision: "skipped", at: "2026-11-10T14:00:00Z", by: "jodi" });
    expect(saved.decisions.f2.draft).toEqual({ number: 7, branch: "cms/media/y" });
    const puts = gh.calls.filter((c) => c.key.startsWith("PUT"));
    expect(JSON.parse(puts[0].init.body).sha).toBeUndefined();
    expect(JSON.parse(puts[1].init.body).sha).toBe("sha-1");
    expect(JSON.parse(puts[1].init.body).branch).toBe("persistent/media-search");
  });

  test("a stale sha is re-read, merged and retried once", async () => {
    const gh = fakeGitHub({ files: { "decisions.json": JSON.stringify({ version: 1, decisions: {} }) }, failOnce: ["PUT /contents/decisions.json"] });
    const a = apiFor(gh);
    const out = await a.recordDecision(FINDING, "skipped", "jodi", "t");
    expect(out.decisions.f1.decision).toBe("skipped");
    expect(keys(gh).filter((k) => k === "PUT /contents/decisions.json")).toHaveLength(2);
    expect(keys(gh).filter((k) => k === "GET /contents/decisions.json")).toHaveLength(2);
  });

  test("a second conflict gives up", async () => {
    const failing = async (u, i) =>
      i.method === "PUT"
        ? { status: 409, ok: false, json: async () => ({}), text: async () => "" }
        : { status: 404, ok: false, json: async () => ({}), text: async () => "" };
    const b = MS.createApi({ fetch: failing, token: "T", adminOrigin: "x", productionBranch: "main" });
    expect((await rejection(b.recordDecision(FINDING, "skipped", "j", "t"))).status).toBe(409);
  });

  test("undo removes the decision", async () => {
    const gh = fakeGitHub({ files: { "decisions.json": JSON.stringify({ version: 1, decisions: { f1: { decision: "skipped", at: "t", by: "j" } } }) } });
    const out = await apiFor(gh).undoDecision(FINDING);
    expect(plain(out)).toEqual({ version: 1, decisions: {} });
  });

  test("Add to site makes the branch, file, pull request and labels, in order", async () => {
    const gh = fakeGitHub();
    const got = await apiFor(gh).openDraft(FINDING);
    expect(got.already).toBe(false);
    expect(got.draft.branch).toBe("cms/media/1-health-policy-academy");
    expect(keys(gh)).toEqual([
      "GET /git/ref/heads/main",
      "POST /git/refs",
      "PUT /contents/_media/1-health-policy-academy.md",
      "POST /pulls",
      `POST /issues/${got.draft.number}/labels`,
    ]);
    const pull = JSON.parse(gh.calls[3].init.body);
    expect(pull.title).toBe("Create Media “1-health-policy-academy”");
    expect(JSON.parse(gh.calls[4].init.body).labels).toEqual(["decap-cms/pending_review", "media-discovery"]);
  });

  test("an existing draft branch counts as already added and is not touched", async () => {
    const gh = fakeGitHub({ refs: ["refs/heads/cms/media/1-health-policy-academy"], existingPull: true });
    const got = await apiFor(gh).openDraft(FINDING);
    expect(got).toEqual({ draft: { number: 9, branch: "cms/media/1-health-policy-academy" }, already: true });
    expect(keys(gh).some((k) => k.startsWith("PUT") || k === "POST /pulls")).toBe(false);
  });

  test("an entry already on the live site removes the empty branch", async () => {
    const gh = fakeGitHub({ fileExistsOnMain: true });
    const got = await apiFor(gh).openDraft(FINDING);
    expect(got).toEqual({ draft: null, already: true });
    expect(keys(gh)).toContain("DELETE /git/refs/heads/cms/media/1-health-policy-academy");
  });

  test("a 401 surfaces with its status so the page can ask for sign-in", async () => {
    const a = MS.createApi({
      fetch: async () => ({ status: 401, ok: false, json: async () => ({}) }),
      token: "T",
      adminOrigin: "x",
      productionBranch: "main",
    });
    expect((await rejection(a.currentUser())).status).toBe(401);
  });
  test.describe("reasonParts: a reason about another page leads with that page's title", () => {
    const PRED = "mentions Jodi Daniel, but doesn't name this item the way the search expected.";
    test("a title becomes the link text and the predicate follows", () => {
      expect(
        MS.reasonParts({ url: "https://www.example.com/a", title: "Annual Meeting 2026", text: PRED }),
      ).toEqual({ lead: "Annual Meeting 2026", href: "https://www.example.com/a", predicate: PRED });
    });
    test("no title (or a blank one) falls back to the host without www.", () => {
      for (const title of [undefined, "", "   ", 5]) {
        expect(MS.reasonParts({ url: "https://www.example.com/a", title, text: PRED })).toEqual({
          lead: "A page on example.com",
          href: "https://www.example.com/a",
          predicate: PRED,
        });
      }
    });
    test("a non-http URL is plain text with no link", () => {
      const got = MS.reasonParts({ url: "javascript:alert(1)", title: "Evil", text: PRED });
      expect(got).toEqual({ lead: "Evil", href: null, predicate: PRED });
      expect(MS.reasonParts({ url: "ftp://example.com/x", text: PRED }).href).toBeNull();
      expect(MS.reasonParts({ url: "ftp://example.com/x", text: PRED }).lead).toBe("Another page");
    });
    test("older full sentences lose their 'Another page' or 'The main link' prefix", () => {
      expect(MS.reasonParts({ url: "https://example.com/", text: "Another page " + PRED }).predicate).toBe(PRED);
      expect(MS.reasonParts({ url: "https://example.com/", text: "another page " + PRED }).predicate).toBe(PRED);
      expect(MS.reasonParts({ main: true, text: "The main link " + PRED })).toEqual({
        lead: "The main link",
        href: null,
        predicate: PRED,
      });
    });
    test("a main-link reason never links, even with a url", () => {
      const got = MS.reasonParts({ main: true, url: "https://example.com/", text: PRED });
      expect(got).toEqual({ lead: "The main link", href: null, predicate: PRED });
    });
    test("a long title is capped at 90 characters with an ellipsis", () => {
      const got = MS.reasonParts({ url: "https://example.com/", title: "x".repeat(200), text: PRED });
      expect(got.lead).toHaveLength(90);
      expect(got.lead.endsWith("\u2026")).toBe(true);
      expect(MS.reasonParts({ url: "https://example.com/", title: "y".repeat(90), text: PRED }).lead).toHaveLength(90);
    });
  });
});
