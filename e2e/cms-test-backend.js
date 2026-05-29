// Shared helpers for specs that drive admin/index-test.html — Decap's
// in-browser `test-repo` backend with editorial_workflow on.
//
// The backend reads its initial state from `window.repoFiles` and
// `window.repoFilesUnpublished`; we seed those via `addInitScript`
// before Decap mounts, so each test starts from a known repo.
//
// Source for the seeding shape:
//   https://github.com/decaporg/decap-cms/blob/main/packages/decap-cms-backend-test/src/implementation.ts

const { expect } = require("./base");

// One canonical seed post used by every editorial-workflow probe.
// Front matter mirrors the real entry the read-only-form bug was
// reported against (empty `slug`/`excerpt`/`featured_image`/
// `publish_date`, null `reading_time`) — keeps the bug-shape parity
// these specs were written to lock in.
const SEED_POST_SLUG = "2026-04-25-replacement-test-post-1";
const SEED_POST_TITLE = "Replacement test post 1";
const SEED_POST_FILENAME = `${SEED_POST_SLUG}.md`;
const SEED_POST_CONTENT = `---
title: ${SEED_POST_TITLE}
slug: ''
date: 2026-04-25 16:33:00 -0400
excerpt: ''
tags: []
featured_image: ''
published: true
publish_date: ''
reading_time: null
---

Wow, a post
`;

function defaultSeed() {
  return {
    repoFiles: {
      _posts: { [SEED_POST_FILENAME]: { content: SEED_POST_CONTENT } },
      _tags: {},
      _projects: {},
      pages: {},
    },
    repoFilesUnpublished: [],
  };
}

// Load admin/index-test.html with a deterministic repo state. Returns
// after Decap has rendered its sidebar, ready to drive the editor.
async function loadTestAdmin(page, { seed = defaultSeed() } = {}) {
  await page.addInitScript((seedJson) => {
    const s = JSON.parse(seedJson);
    window.repoFiles = s.repoFiles;
    window.repoFilesUnpublished = s.repoFilesUnpublished;
  }, JSON.stringify(seed));

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));

  await page.goto("/admin/index-test.html");
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({
    timeout: 30_000,
  });
}

// Read the current draft contents for a `${collection}/${slug}` key.
// Returns the markdown file content the backend would persist, or
// null if no draft exists yet.
function readDraftContent(page, { collection, slug }) {
  return page.evaluate(
    ({ c, s }) => {
      const map = window.repoFilesUnpublished || {};
      const entry = map[`${c}/${s}`];
      if (!entry || !entry.diffs || !entry.diffs.length) return null;
      return entry.diffs[0].content;
    },
    { c: collection, s: slug },
  );
}

module.exports = {
  SEED_POST_SLUG,
  SEED_POST_TITLE,
  SEED_POST_FILENAME,
  SEED_POST_CONTENT,
  defaultSeed,
  loadTestAdmin,
  readDraftContent,
};
