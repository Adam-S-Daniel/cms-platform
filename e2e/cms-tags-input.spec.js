// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (cms-platform#638) ───────────────────────────────────
// Posts' Tags is Decap's plain `list` widget: one text box split on commas.
// Out of the box, `alpha, beta` saved ONE tag `alphabeta` (Decap rewrites the
// box to "alpha, " after the comma and the editor's own space then makes it
// drop the comma), and Enter — which the hint promised — did nothing, so
// `one<Enter>two` saved `onetwo`. admin/tags-input.js fixes both. This spec is
// the half a stand-in cannot give: the real Decap editor, real key presses, and
// the real front matter Decap writes.
//
// Harness: index-test.html (Decap's in-browser test-repo backend,
// editorial_workflow); a Save lands as an editorial draft whose
// `diffs[0].content` is the exact file text Decap would commit. Seed/login
// pattern mirrors cms-slug-pin.spec.js.

async function openNewPost(page) {
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
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/posts/new");
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel(/^Title$/).fill("Tags input check");
  const body = page.locator('[role="textbox"][contenteditable="true"]').last();
  await body.click();
  await body.pressSequentially("Body text.");
}

async function savedTags(page) {
  await page.getByRole("button", { name: /^save$/i }).first().click();
  await expect(page.getByRole("button", { name: /^save$/i }).first()).toBeDisabled({ timeout: 30_000 });
  const text = await page.evaluate(() => {
    for (const entry of Object.values(window.repoFilesUnpublished || {})) {
      if (entry && entry.diffs && entry.diffs.length) return entry.diffs[0].content;
    }
    return "";
  });
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  expect(fm, `a saved post with front matter (got: ${text.slice(0, 80)})`).toBeTruthy();
  const lines = fm[1].split("\n");
  const at = lines.findIndex((l) => /^tags:/.test(l));
  expect(at, "a tags key in the saved front matter").toBeGreaterThanOrEqual(0);
  const inline = /^tags:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  const out = [];
  for (let i = at + 1; i < lines.length && /^\s*-\s/.test(lines[i]); i++) {
    out.push(lines[i].replace(/^\s*-\s*/, "").replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

test.describe(
  "CMS Tags box splits on comma-space and on Enter (#638)",
  // Tagged @admin-write: drives /admin/* and writes an editorial draft.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("typing `a, b` saves two tags", async ({ page }) => {
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("alpha, beta");
      expect(await savedTags(page)).toEqual(["alpha", "beta"]);
    });

    test("Enter ends a tag, and the hint does not promise more than that", async ({ page }) => {
      await openNewPost(page);
      await expect(page.getByText(/press Enter, or separate tags with commas/)).toBeVisible();
      await expect(page.getByText(/auto_tag_pages/)).toHaveCount(0);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("zz-test");
      await tags.press("Enter");
      await tags.pressSequentially("ai");
      expect(await savedTags(page)).toEqual(["zz-test", "ai"]);
    });
  },
);
