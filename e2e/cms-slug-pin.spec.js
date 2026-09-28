// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (adamdaniel.ai#3857) ─────────────────────────────────
// A post is served at `/blog/<front-matter slug>/`, falling back to its FILE
// NAME, and Decap names the file from the title at the first save and never
// renames it. With URL Slug blank, editing the title after that first save
// left the page at its old address while the admin banner and the required
// cms-preview-url / console-clean checks looked for it at the new title's —
// they 404'd and blocked the publish.
//
// admin/slug-pin.js fills an empty URL Slug on Save. The pure logic is unit-
// tested in slug-pin.test.js against a stand-in for Decap's entry map; THIS
// spec is the half a stand-in cannot give: the real Decap 3.15.1 editor, real
// clicks on the real Save button, and the real front matter Decap writes. It
// is what would catch Decap passing the preSave handler an entry shaped
// differently from what the shim assumes (`collection`, `newRecord`, `slug`).
//
// ── Harness ───────────────────────────────────────────────────────────────
// index-test.html is Decap's in-browser test-repo backend with
// publish_mode: editorial_workflow (config-test.yml — a FIXED config that
// base_collections never strips, so no #33 guard is needed; the same reasoning
// as cms-autosave.spec.js, whose seed/login pattern this mirrors). A Save lands
// as an editorial draft in window.repoFilesUnpublished, the in-browser analog
// of the cms/<collection>/<slug> branch, and its `diffs[0].content` is the
// exact file text Decap would commit.

const TITLE_V1 = "Quoting Simon Willison on Coding Agents";
const TITLE_V2 = "Quoting Simon Willison on Unlocking Coding Agents’ Potential";
const FILE_SLUG = "2026-09-28-quoting-simon-willison-on-coding-agents";

function seedPost({ slugLine }) {
  return `---
title: ${TITLE_V1}
${slugLine}
date: 2026-09-28 09:10:00 -0400
excerpt: ''
tags: []
featured_image: ''
published: true
publish_date: ''
---

> The more time I spend working with coding agents…
`;
}

async function seedAdmin(page, posts) {
  const repoFiles = { _posts: {}, _tags: {}, _projects: {}, pages: {} };
  for (const [name, content] of Object.entries(posts)) repoFiles._posts[name] = { content };
  await page.addInitScript((json) => {
    const s = JSON.parse(json);
    window.repoFiles = s.repoFiles;
    window.repoFilesUnpublished = [];
    // Keep cms-autosave's idle timer out of this spec's way: only the Save
    // click below may save.
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  }, JSON.stringify({ repoFiles }));
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
}

async function login(page) {
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
}

// Every editorial draft's committed file text, keyed by its content key.
async function drafts(page) {
  return page.evaluate(() => {
    const out = {};
    const map = window.repoFilesUnpublished || {};
    for (const [key, entry] of Object.entries(map)) {
      if (entry && entry.diffs && entry.diffs.length) out[key] = entry.diffs[0].content;
    }
    return out;
  });
}

async function save(page) {
  await page.getByRole("button", { name: /^save$/i }).first().click();
  // Decap disables Save once the draft is persisted (nothing left unsaved).
  await expect(page.getByRole("button", { name: /^save$/i }).first()).toBeDisabled({ timeout: 30_000 });
}

function frontMatterSlug(fileText) {
  const m = /^---\n([\s\S]*?)\n---/.exec(fileText || "");
  if (!m) return undefined;
  const line = m[1].split("\n").find((l) => /^slug:/.test(l));
  return line === undefined ? undefined : line.replace(/^slug:\s*/, "").replace(/^['"]|['"]$/g, "");
}

test.describe(
  "CMS URL Slug is pinned on Save, so a title edit cannot move a post (#3857)",
  // Tagged @admin-write: drives /admin/* and writes an editorial draft.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("an existing post with a blank URL Slug keeps its address when its title is edited", async ({ page }) => {
      await seedAdmin(page, { [`${FILE_SLUG}.md`]: seedPost({ slugLine: "slug: ''" }) });
      await login(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${FILE_SLUG}`);

      const title = page.getByLabel(/^Title$/);
      await expect(title).toBeVisible({ timeout: 60_000 });
      await title.fill(TITLE_V2);
      await save(page);

      const saved = await drafts(page);
      const text = saved[`posts/${FILE_SLUG}`];
      expect(text, `a draft for posts/${FILE_SLUG} (have: ${Object.keys(saved).join(", ")})`).toBeTruthy();
      expect(text).toContain(`title: ${TITLE_V2}`);
      expect(frontMatterSlug(text), "the address it already had, from its file name").toBe(
        "quoting-simon-willison-on-coding-agents",
      );
      // And the editor shows it, so the editor can see what was written.
      await expect(page.getByLabel(/^URL Slug/)).toHaveValue("quoting-simon-willison-on-coding-agents");
    });

    test("an explicit URL Slug is left exactly as typed", async ({ page }) => {
      await seedAdmin(page, { [`${FILE_SLUG}.md`]: seedPost({ slugLine: "slug: my-chosen-address" }) });
      await login(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${FILE_SLUG}`);

      const title = page.getByLabel(/^Title$/);
      await expect(title).toBeVisible({ timeout: 60_000 });
      await title.fill(TITLE_V2);
      await save(page);

      const text = (await drafts(page))[`posts/${FILE_SLUG}`];
      expect(frontMatterSlug(text)).toBe("my-chosen-address");
    });

    test("a new post gets its title's slug on its first save, and a later title edit keeps it", async ({ page }) => {
      await seedAdmin(page, {});
      await login(page);
      await page.goto("/admin/index-test.html#/collections/posts/new");

      const title = page.getByLabel(/^Title$/);
      await expect(title).toBeVisible({ timeout: 60_000 });
      await title.fill(TITLE_V1);
      const body = page.locator('[role="textbox"][contenteditable="true"]').last();
      await body.click();
      await body.pressSequentially("Body text.");
      await save(page);

      let saved = await drafts(page);
      const keys = Object.keys(saved).filter((k) => k.startsWith("posts/"));
      expect(keys, "exactly one new post draft").toHaveLength(1);
      expect(frontMatterSlug(saved[keys[0]])).toBe("quoting-simon-willison-on-coding-agents");

      // The #3857 sequence: retitle after the first save, save again.
      await page.getByLabel(/^Title$/).fill(TITLE_V2);
      await save(page);
      saved = await drafts(page);
      expect(saved[keys[0]]).toContain(`title: ${TITLE_V2}`);
      expect(frontMatterSlug(saved[keys[0]]), "the retitle must not move the address").toBe(
        "quoting-simon-willison-on-coding-agents",
      );
    });
  },
);
