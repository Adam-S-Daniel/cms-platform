// @lane: local — pure-fs lint on the regression-reviews dashboard
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { parse } = require("./spec-ast");

// Locks the dashboard's pending-run discovery to the workflow PATH.
//
// Consumers set a dynamic `run-name:` on the visual-regression thin caller
// (house convention: every workflow titles its runs per-trigger), and the
// Actions API returns that as the run's `name`. The dashboard's original
// `r.name === 'Visual Regression'` filter therefore matched NOTHING once a
// consumer adopted run-names — it showed "No pending regression reviews"
// while a run sat waiting on the regression-review gate (observed live on
// adamdaniel.ai#2554, the v0.1.59 bump). `path` is immune to run-naming.

const DASHBOARD = path.join(__dirname, "..", "theme", "admin", "reviews", "index.html");

function dashboardScript() {
  const html = fs.readFileSync(DASHBOARD, "utf8");
  // HTML delimiters are lexical tokens. The JavaScript shape is parsed below.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  return scripts.find((script) =>
    parse(script[1]).body.some((node) => node.type === "FunctionDeclaration" && node.id.name === "loadReviews"),
  )[1];
}

test.describe("reviews dashboard: pending-run discovery", () => {
  test("filters waiting runs by workflow path, never by run name", () => {
    const comparisons = [];
    walk.simple(parse(dashboardScript()), {
      BinaryExpression(node) {
        if (node.operator === "===" && node.left.type === "MemberExpression" &&
            !node.left.computed && node.left.object.type === "Identifier" &&
            node.left.object.name === "r" && node.right.type === "Literal") {
          comparisons.push([node.left.property.name, node.right.value]);
        }
      },
    });
    expect(comparisons).toContainEqual(["path", ".github/workflows/visual-regression.yml"]);
    expect(comparisons).not.toContainEqual(["name", "Visual Regression"]);
  });
});

test("each pending review has its own named, labeled rejection comment", async () => {
  const source = dashboardScript();
  const loadReviews = parse(source).body.find((node) =>
    node.type === "FunctionDeclaration" && node.id.name === "loadReviews",
  );
  const validIds = [101, 202];
  const runs = [...validIds, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'bad"id'].map((id) => ({
    id,
    path: ".github/workflows/visual-regression.yml",
    head_sha: "abcdef1234567890",
    pull_requests: [{ number: id }],
  }));
  const list = { innerHTML: "", querySelectorAll: () => [] };
  const context = vm.createContext({
    REPO_OWNER: "example",
    REPO_NAME: "reviews",
    APEX_DOMAIN: "example.com",
    document: { getElementById: () => list },
    escapeHtml: (text) => String(text),
    ghFetch: async (url) => ({
      json: async () => url.includes("pending_deployments")
        ? [{ environment: { id: 7 } }]
        : url.includes("/pulls/")
          ? { title: "Synthetic review", head: { ref: "cms/example" } }
          : { workflow_runs: runs },
    }),
  });
  await vm.runInContext(`${source.slice(loadReviews.start, loadReviews.end)}; loadReviews()`, context);
  // Assert the runtime output for TWO simultaneous cards so a fixed ID
  // cannot accidentally associate both labels with the first textarea.
  const parsed = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
from html.parser import HTMLParser
class Controls(HTMLParser):
    def __init__(self):
        super().__init__()
        self.controls, self.labels, self.ids = [], [], []
        self.label = None
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if tag == 'textarea':
            self.controls.append(attrs)
        if tag == 'label':
            self.label = dict(attrs, text='')
            self.labels.append(self.label)
    def handle_data(self, text):
        if self.label is not None:
            self.label['text'] += text
    def handle_endtag(self, tag):
        if tag == 'label':
            self.label = None
p = Controls()
p.feed(sys.stdin.read())
print(json.dumps(dict(controls=p.controls, labels=p.labels, ids=p.ids)))
`], { input: list.innerHTML, encoding: "utf8" }));
  expect(parsed.controls).toHaveLength(validIds.length);
  for (const control of parsed.controls) {
    expect(control.id).toBeTruthy();
    expect(control.name).toBe("comment");
    expect(parsed.ids.filter((id) => id === control.id)).toHaveLength(1);
    expect(parsed.labels.filter((label) => label.for === control.id).map((label) => label.text.trim()))
      .toEqual(["Changes needed"]);
  }
});
