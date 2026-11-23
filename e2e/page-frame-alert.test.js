// Unit tests for scripts/page-frame-alert.js's pure parts (cms-platform#1070).
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const alert = require(path.join(__dirname, "..", "scripts", "page-frame-alert.js"));

const report = {
  suites: [
    {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: "unexpected",
                  annotations: [
                    { type: "page", description: "/blog/a/" },
                    { type: "source", description: "_posts/2026-01-01-a.md" },
                  ],
                  results: [{ error: { message: "\u001b[31mThe page frame is broken:\n  header gone\u001b[39m" } }],
                },
                { status: "expected", annotations: [{ type: "page", description: "/blog/" }], results: [{}] },
                { status: "skipped", annotations: [{ type: "page", description: "/" }], results: [{}] },
                { status: "expected", annotations: [], results: [{}] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test.describe("page-frame alert", () => {
  test("reads each page's outcome, source and message from the report", () => {
    expect(alert.parseReport(report)).toEqual([
      { page: "/blog/a/", source: "_posts/2026-01-01-a.md", outcome: "failed", message: "The page frame is broken:\n  header gone" },
      { page: "/blog/", source: null, outcome: "passed", message: "" },
      { page: "/", source: null, outcome: "skipped", message: "" },
    ]);
  });

  test("opens an issue for a new failure, leaves a tracked one, closes a fixed one", () => {
    const results = [
      { page: "/blog/a/", outcome: "failed" },
      { page: "/blog/b/", outcome: "failed" },
      { page: "/blog/", outcome: "passed" },
      { page: "/", outcome: "skipped" },
    ];
    const issues = [
      { number: 7, body: "<!-- page-frame: /blog/b/ -->\n" },
      { number: 8, body: "<!-- page-frame: /blog/ -->\n" },
      { number: 9, body: "<!-- page-frame: / -->\n" },
    ];
    const p = alert.plan(results, issues);
    expect(p.open.map((r) => r.page)).toEqual(["/blog/a/"]);
    expect(p.still.map((r) => r.issue.number)).toEqual([7]);
    expect(p.close.map((r) => r.issue.number)).toEqual([8]);
  });

  test("the daily sweep closes the issue of a post no longer published; a push run does not", () => {
    const results = [{ page: "/blog/a/", outcome: "passed" }];
    const issues = [{ number: 5, body: "<!-- page-frame: /blog/gone/ -->\n" }];
    expect(alert.plan(results, issues, { all: true }).gone.map((g) => g.issue.number)).toEqual([5]);
    expect(alert.plan(results, issues).gone).toEqual([]);
  });

  test("a daily sweep that checked no page closes nothing as no longer published", () => {
    // A run that crashed before any page test (a spec that failed to load, a
    // global setup error) leaves an empty report: that is not every post gone.
    const issues = [{ number: 5, body: "<!-- page-frame: /blog/a/ -->\n" }];
    expect(alert.plan([], issues, { all: true }).gone).toEqual([]);
  });

  test("unpublishing changes only the published line", () => {
    const src = "---\ntitle: A\npublished: true\ntags: [x]\n---\n\nBody with published: true\n";
    expect(alert.unpublishFrontMatter(src)).toBe(
      "---\ntitle: A\npublished: false\ntags: [x]\n---\n\nBody with published: true\n",
    );
  });

  test("unpublishing adds the line when it is missing, keeping CRLF", () => {
    const src = "---\r\ntitle: A\r\n---\r\nBody\r\n";
    expect(alert.unpublishFrontMatter(src)).toBe("---\r\ntitle: A\r\npublished: false\r\n---\r\nBody\r\n");
  });

  test("an already unpublished post or one without front matter is left alone", () => {
    expect(alert.unpublishFrontMatter("---\npublished: false\n---\n")).toBeNull();
    expect(alert.unpublishFrontMatter("no front matter")).toBeNull();
  });

  test("the issue body carries the page marker, the PR marker and the fix", () => {
    const body = alert.issueBody({
      result: { page: "/blog/a/", source: "_posts/a.md", message: "header gone" },
      sha: "abc",
      prodUrl: "https://example.com/",
      pr: { number: 12, html_url: "https://github.com/o/r/pull/12" },
    });
    expect(alert.pageFromIssue({ body })).toBe("/blog/a/");
    expect(body).toContain("<!-- page-frame-unpublish-pr: 12 -->");
    expect(body).toContain("https://example.com/blog/a/");
    expect(body).toContain("merge https://github.com/o/r/pull/12");
    const noApp = alert.issueBody({
      result: { page: "/blog/a/", source: "_posts/a.md", message: "x" },
      sha: "abc",
      prError: "the CMS automation App is not set up on this repository",
    });
    expect(noApp).toContain("turn off Published");
    expect(noApp).not.toContain("page-frame-unpublish-pr");
  });

  test("branch slugs stay short and safe", () => {
    expect(alert.slugOf("/blog/a b/")).toBe("blog-a-b");
    expect(alert.slugOf("/")).toBe("home");
  });
});
