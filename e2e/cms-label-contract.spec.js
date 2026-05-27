// @lane: local — uses cms-test-backend to assert label-contract on the local /admin
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { SEED_POST_SLUG, loadTestAdmin } = require("./cms-test-backend");
const { parseYaml, allStrings } = require("./workflow-yaml-utils");

// Audit finding #1: the editor and the merge-gate workflow must agree
// on the EXACT label string that flips a CMS PR from draft → ready.
//
// Bug shape: a Decap upgrade started emitting `decap-cms/ready` for the
// "Ready" status while .github/workflows/cms-editorial-workflow.yml
// kept listening for `cms/ready`. Net effect: the CMS PR shows the
// label but auto-merge never fires → editor thinks the publish loop
// is broken.
//
// Two layers of defence:
//   1. Static — parse the workflow YAML and assert the label its
//      auto-merge job listens for is the same one its validate-content
//      job creates.
//   2. Runtime — drive Decap under editorial_workflow and assert the
//      bundle does NOT write any `decap-cms/`-prefixed status string
//      into the unpublished payload (which would be the smoking-gun
//      shape of a future namespace divergence).

const REPO_ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(REPO_ROOT, ".github/workflows/cms-editorial-workflow.yml");

// The label tokens live inside string values — the `if:` expression and
// the github-script `createLabel(...)` JS — so we parse the workflow and
// search those resolved strings rather than grepping raw file text. That
// keeps the expression/JS regexes (which match content, not YAML shape)
// while being robust to anchors and never matching a commented mention.
function workflowStrings(yml) {
  return allStrings(parseYaml(yml)).join("\n");
}

function readyLabelFromWorkflow(yml) {
  const m = workflowStrings(yml).match(/github\.event\.label\.name\s*==\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

function labelsCreatedByValidateContent(yml) {
  return [...workflowStrings(yml).matchAll(/createLabel\([^)]*name:\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );
}

test.describe(
  "Label namespace contract: Decap ↔ cms-editorial-workflow.yml",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 120_000 });

    test("auto-merge listens for the same `cms/ready` label that validate-content creates", () => {
      const yml = fs.readFileSync(WORKFLOW, "utf8");
      const ready = readyLabelFromWorkflow(yml);
      expect(
        ready,
        "cms-editorial-workflow.yml must contain a `github.event.label.name == '<X>'` guard",
      ).not.toBeNull();
      expect(ready).toBe("cms/ready");

      const created = labelsCreatedByValidateContent(yml);
      expect(created).toEqual(expect.arrayContaining(["cms/draft", "cms/ready"]));
      expect(
        created,
        `auto-merge trigger label "${ready}" must be created by validate-content (got: ${JSON.stringify(created)})`,
      ).toContain(ready);
    });

    test.describe("Runtime: Decap status namespace matches workflow listener", () => {
      test.beforeEach(async () => {});

      test("Save → no `decap-cms/`-prefixed status string leaks into repoFilesUnpublished", async ({
        page,
      }) => {
        await loadTestAdmin(page);
        await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);
        const titleField = page.getByLabel(/^Title$/);
        await expect(titleField).toBeVisible({ timeout: 60_000 });
        await titleField.fill("Replacement test post 1 — label-contract probe");

        await page
          .getByRole("button", { name: /^save$/i })
          .first()
          .click();

        // Wait for the draft to materialise.
        await expect
          .poll(
            () =>
              page.evaluate((k) => {
                const map = window.repoFilesUnpublished || {};
                return map[k] ? "present" : null;
              }, `posts/${SEED_POST_SLUG}`),
            { timeout: 30_000 },
          )
          .toBe("present");

        // Walk repoFilesUnpublished and collect every string value — the
        // status token lives somewhere in here. Stringify-flatten is
        // robust to test-repo shape drift across Decap versions.
        const decapPrefixed = await page.evaluate(() => {
          const out = [];
          const seen = new WeakSet();
          function walk(v) {
            if (typeof v === "string") {
              if (/^decap-cms\//.test(v)) out.push(v);
              return;
            }
            if (!v || typeof v !== "object" || seen.has(v)) return;
            seen.add(v);
            for (const k of Object.keys(v)) walk(v[k]);
          }
          walk(window.repoFilesUnpublished);
          return out;
        });

        expect(
          decapPrefixed,
          `Decap must not write any "decap-cms/..." status string into repoFilesUnpublished — the workflow listens for the unprefixed "cms/<status>" namespace. Found: ${JSON.stringify(decapPrefixed)}`,
        ).toEqual([]);
      });
    });
  },
);
