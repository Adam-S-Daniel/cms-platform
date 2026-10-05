// @lane: local — pure-Node behavioral test for posts-list-enhance.js (vm sandbox) + posts sort config (#650)
/*
 * Posts list, issue #650:
 *   1. a card says its status ONCE (no " — DRAFT" in the visible title, no
 *      Live + Hidden pair);
 *   2. an all-fixture list says "No posts match" instead of going blank;
 *   3. a live post's path is a link at once and never carries the
 *      "once published" tooltip;
 *   4. the Posts collection sorts by date, newest first, by default;
 *   5. the printed date is the front-matter date, not the file name's.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "posts-list-enhance.js"), "utf8");
const MODEL = fs.readFileSync(path.join(ADMIN, "entry-status-model.js"), "utf8");

function load({ fetch } = {}) {
  const sandbox = {
    window: {
      CMS_REPO: "owner/repo",
      CMS_SITE_ORIGIN: "https://example.com",
      CMS_APEX: "example.com",
      location: { hash: "#/" },
      addEventListener() {},
    },
    document: { readyState: "complete", body: {}, addEventListener() {} },
    requestAnimationFrame: () => 0,
    MutationObserver: class {
      observe() {}
    },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: fetch || (() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(MODEL, sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.window.__postsListEnhance;
}

function card(over = {}) {
  const slug = over.slug || "2026-05-12-hello";
  return {
    slug,
    filePath: `_posts/${slug}.md`,
    isFixture: false,
    postDate: "2026-05-12",
    state: { label: "Published", color: "#1a7f37", live: true },
    ...over,
  };
}

const ON_MAIN = (fmDate) => ({
  lastEdited: { "_posts/2026-05-12-hello.md": { date: "2026-05-13T12:00:00Z", fmDate } },
  prBySlug: {},
  checksFailedBySha: {},
});

test.describe("one status per card (#650 problem 1)", () => {
  test("the visible title loses the summary's DRAFT suffix but the raw state survives re-reads", () => {
    const hook = load();
    expect(hook.stripSummarySuffix("Hello — DRAFT")).toBe("Hello");
    expect(hook.stripSummarySuffix("Hello — DRAFT — Scheduled")).toBe("Hello");
    expect(hook.stripSummarySuffix("Hello")).toBe("Hello");

    const node = { nodeType: 3, nodeValue: "Hello — DRAFT" };
    const h2 = { childNodes: [node] };
    const a = {};
    expect(hook.hideSummarySuffix(a, h2, "Hello — DRAFT")).toBe("Hello — DRAFT");
    expect(node.nodeValue, "the suffix is removed from the visible text").toBe("Hello");
    // The next pass sees the stripped text and must still know it was a draft.
    expect(hook.hideSummarySuffix(a, h2, "Hello")).toBe("Hello — DRAFT");
    expect(node.nodeValue).toBe("Hello");
  });

  test("an unpublished entry shows one Draft chip: not Live, not Hidden", () => {
    const hook = load();
    const draft = card({ state: { label: "Draft", color: "#57606a", live: false } });
    const badge = hook.badgeFor(draft, ON_MAIN("2026-05-12"));
    expect(badge.label).toBe("Draft");
    expect(badge.modifiers).toEqual([]);
  });

  test("a Scheduled entry keeps its Scheduled modifier", () => {
    const hook = load();
    const sched = card({ state: { label: "Scheduled", color: "#9a6700", live: false } });
    expect(hook.badgeFor(sched, ON_MAIN("2026-05-12")).modifiers).toEqual(["Scheduled"]);
  });
});

test.describe("empty list says so (#650 problem 2)", () => {
  test("all-fixture list with the toggle off explains itself; toggle on or real posts: silent", () => {
    const hook = load();
    const fx = (n) => Array.from({ length: n }, () => card({ isFixture: true }));
    expect(hook.emptyStateText(fx(2), false)).toMatch(/^No posts match\./);
    expect(hook.emptyStateText(fx(2), false)).toContain("2 automated-test posts are hidden");
    expect(hook.emptyStateText(fx(1), false)).toContain("1 automated-test post is hidden");
    expect(hook.emptyStateText(fx(2), true)).toBe("");
    expect(hook.emptyStateText([card(), ...fx(2)], false)).toBe("");
    expect(hook.emptyStateText([], false)).toBe("");
  });
});

test.describe("live post link and tooltip (#650 problem 3)", () => {
  test("a live post is a link on first render, before any remote data", () => {
    const html = load().metaHTML(card(), null);
    expect(html).toContain("published ↗");
    expect(html).not.toContain("once published");
  });

  test("a live post with no open PR stays a link even when the history lookup missed it", () => {
    const html = load().metaHTML(card(), { lastEdited: {}, prBySlug: {}, checksFailedBySha: {} });
    expect(html).toContain("published ↗");
    expect(html).not.toContain("once published");
  });

  test("a post whose edit is still in an open PR keeps the honest tooltip", () => {
    const remote = {
      lastEdited: {},
      prBySlug: { "2026-05-12-hello": { number: 7, url: "https://github.com/owner/repo/pull/7" } },
      checksFailedBySha: {},
    };
    const html = load().metaHTML(card(), remote);
    expect(html).toContain("once published");
    expect(html).not.toContain("published ↗");
  });
});

test.describe("date comes from front matter (#650 problem 5)", () => {
  test("frontMatterDate reads the calendar day in the written offset", () => {
    const hook = load();
    const text = "---\ntitle: X\ndate: 2026-05-13 08:51:00 -0400\n---\nbody\ndate: 1999-01-01\n";
    expect(hook.frontMatterDate(text)).toBe("2026-05-13");
    expect(hook.frontMatterDate('---\r\ndate: "2026-05-13 08:51 -0400"\r\n---\r\n')).toBe(
      "2026-05-13",
    );
    expect(hook.frontMatterDate("no front matter\ndate: 2026-05-13")).toBeNull();
    expect(hook.frontMatterDate("---\ntitle: X\n---\n")).toBeNull();
  });

  test("the card prints the front-matter date, falling back to the file name's", () => {
    const hook = load();
    const withFm = hook.metaHTML(card(), ON_MAIN("2026-05-13"));
    expect(withFm).toContain(">2026-05-13<");
    expect(withFm).toContain("front matter");
    expect(withFm).not.toContain(">2026-05-12<");
    const without = hook.metaHTML(card(), ON_MAIN(null));
    expect(without).toContain(">2026-05-12<");
    expect(without).toContain("file name");
  });

  test("fetchLastEdited reads the blobs in the same single GraphQL request", async () => {
    const bodies = [];
    const hook = load({
      fetch: (url, init) => {
        bodies.push(JSON.parse(init.body).query);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                repository: {
                  ref: {
                    target: {
                      f0: {
                        nodes: [
                          {
                            committedDate: "2026-05-13T12:00:00Z",
                            url: "u",
                            associatedPullRequests: { nodes: [] },
                          },
                        ],
                      },
                    },
                  },
                  b0: { text: "---\ndate: 2026-05-13 08:51 -0400\n---\n" },
                },
              },
            }),
        });
      },
    });
    const out = await hook.fetchLastEdited("t0k3n", [card()]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(
      'b0: object(expression: "refs/heads/main:_posts/2026-05-12-hello.md")',
    );
    expect(out["_posts/2026-05-12-hello.md"].fmDate).toBe("2026-05-13");
  });
});

test.describe("default sort is newest first (#650 problem 4)", () => {
  for (const f of ["config.base.yml", "config-local.base.yml", "config-test.yml"]) {
    test(`${f}: posts sort by date, descending, by default`, () => {
      const cfg = YAML.parse(fs.readFileSync(path.join(ADMIN, f), "utf8"));
      const posts = cfg.collections.find((c) => c.name === "posts");
      expect(posts.sortable_fields.fields).toEqual(["date", "title"]);
      expect(posts.sortable_fields.default).toEqual({ field: "date", direction: "Descending" });
    });
  }
});
