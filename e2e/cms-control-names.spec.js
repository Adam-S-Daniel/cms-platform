// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves ──────────────────────────────────────────────────────
// Decap's icon-only controls reach a screen reader with no name, or with the
// same name on every row. theme/admin/list-row-affordance.js names them, and
// the unit half (vm sandbox, a fake row) is list-row-affordance.test.js. This
// is the half a stand-in cannot give: the real Decap 3.15.1 bundle, so a Decap
// release that moves the DOM the shim keys on fails here, by name, and not in
// a keyboard tester's ears. Every assertion is by accessible name through
// getByRole, which is what a screen reader reads.
//
// Harness: index-test.html (Decap's in-browser test-repo backend). The Pages
// collection gets a list whose rows summarize by a "Link label" field, the same
// way the About and Contact lists of the sites do. Nothing is saved.

const EXTRA_FIELDS = `
      - name: links
        label: Links
        widget: list
        required: false
        summary: "{{fields.label}}"
        fields:
          - { name: label, label: "Link label", widget: string }
          - { name: url, label: URL, widget: string }
`;

async function openNewPage(page) {
  await page.route(/\/admin\/config-test\.yml$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: "text/yaml", body: (await res.text()) + EXTRA_FIELDS });
  });
  await page.addInitScript(() => {
    window.repoFiles = { _posts: {}, _tags: {}, _projects: {}, pages: {} };
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^pages$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/pages/new");
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
}

const named = (page, role, name) => page.getByRole(role, { name, exact: true });

test.describe(
  "Unnamed Decap controls are named for a screen reader",
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 180_000 });

    test("each list row's chevron, drag handle and remove button say which row", async ({ page }) => {
      await openNewPage(page);
      const add = page.getByRole("button", { name: /^add links$/i });

      // A brand-new row is named before its summary exists (Decap shows its own
      // placeholder summary for it), by position first.
      await add.click();
      await expect(page.getByRole("button", { name: /^Delete item 1\b/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Move item 1\b/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Expand or collapse item 1\b/ })).toBeVisible();

      await page.getByLabel(/^Link label$/).first().fill("Alpha");
      await add.click();
      await page.getByLabel(/^Link label$/).nth(1).fill("Beta");

      for (const [n, summary] of [
        [1, "Alpha"],
        [2, "Beta"],
      ]) {
        await expect(named(page, "button", `Delete item ${n} (${summary})`)).toBeVisible();
        await expect(named(page, "button", `Move item ${n} (${summary})`)).toBeVisible();
        await expect(named(page, "button", `Expand or collapse item ${n} (${summary})`)).toBeVisible();
      }

      // Names follow the row as the editor types in it...
      await page.getByLabel(/^Link label$/).nth(1).fill("Gamma");
      await expect(named(page, "button", "Delete item 2 (Gamma)")).toBeVisible();
      await expect(named(page, "button", "Delete item 2 (Beta)")).toHaveCount(0);

      // ...and renumber when a row above it goes away.
      await named(page, "button", "Delete item 1 (Alpha)").click();
      await expect(named(page, "button", "Delete item 1 (Gamma)")).toBeVisible();
      await expect(named(page, "button", "Delete item 2 (Gamma)")).toHaveCount(0);
    });

    test("the Back link, the Rich Text / Markdown switch and the body textbox have names", async ({ page }) => {
      await openNewPage(page);
      await page.getByLabel(/^Title$/).fill("Control names check");

      // Name is Decap's own "Writing in Pages collection", led by "Back to", and
      // carries neither the arrow glyph nor the save-status badge.
      await expect(named(page, "link", "Back to Writing in Pages collection")).toBeVisible();

      await expect(named(page, "switch", "Edit Content as Markdown")).toBeVisible();
      await expect(named(page, "textbox", "Content")).toBeVisible();

      // Still named after Decap swaps the editor for its Markdown mode.
      await named(page, "switch", "Edit Content as Markdown").click();
      await expect(named(page, "switch", "Edit Content as Markdown")).toBeChecked();
      await expect(named(page, "textbox", "Content")).toBeVisible();
    });
  },
);
