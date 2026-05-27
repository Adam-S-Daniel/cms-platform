// @lane: local — drives the local /admin shell to assert form hint text
/**
 * @file e2e/cms-form-clarity.spec.js
 *
 * Locks current form hint text against drift, and documents a deferred
 * redesign proposal:
 *
 * Today: posts have a `published` boolean + a `publish_date` datetime.
 * Editors get a label + hint, but the relationship is implicit:
 *   - "Published OFF + Publish Date set" = scheduled
 *   - "Published OFF + no Publish Date" = draft
 *   - "Published ON" = live (publish_date ignored)
 *
 * Proposed: replace the boolean with a `status` select (Draft / Scheduled /
 * Published). Make `publish_date` conditionally visible only when status =
 * Scheduled. Implementation deferred to a follow-up PR — this spec just
 * locks the current state so we know when to revisit the snapshot.
 */
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");

// ── Config readers ───────────────────────────────────────────────────
//
// The configs are parsed with the real YAML library, so a field's
// `hint:` is read as the value Decap actually shows — independent of
// quoting style, line length, or any future anchors — rather than
// scraped off the line by regex.

function parseConfig(file) {
  return YAML.parse(fs.readFileSync(file, "utf8")) || {};
}

function findCollection(cfg, name) {
  return ((cfg && cfg.collections) || []).find((c) => c && c.name === name) || null;
}

function findField(collection, fieldName) {
  return ((collection && collection.fields) || []).find((f) => f && f.name === fieldName) || null;
}

function hintFor(cfg, collectionName, fieldName) {
  const field = findField(findCollection(cfg, collectionName), fieldName);
  return field && field.hint != null ? String(field.hint) : null;
}

// ── Expected snapshots ───────────────────────────────────────────────
//
// One snapshot per config file. Every (collection, field) pair listed
// here MUST have its hint match the literal — and fields with an
// expected hint of `null` MUST NOT have a hint set. That second half is
// what catches "someone added a hint to config-test.yml without adding
// the matching prod hint to config.yml" drift.

const PROD_HINTS = {
  posts: {
    title: "The post headline — make it compelling",
    slug: "URL path segment (leave blank to auto-generate from title). Must match any existing published URL to avoid breaking inbound links.",
    excerpt: "A short summary shown in post listings and meta tags (≤ 160 chars recommended)",
    featured_image: "Displayed as the post hero image and in social sharing cards",
    published:
      "ON = goes live on the next deploy. Leave OFF to schedule a future publish via the Publish Date below — the scheduled-posts workflow flips this toggle on when the date arrives.",
    publish_date:
      "Optional. Future date/time (UTC) to auto-publish this post. Only honoured when Published above is OFF — if Published is ON, the post goes live immediately and this field is ignored.",
    body: "Full post content. Supports Markdown, images, code blocks, and HTML embeds (toolbar → 'HTML Embed' button — drops a block of raw HTML / JS / CSS that round-trips between rich-text and raw modes). For a real-layout preview that updates on every Save, open /preview/?collection=posts in a second browser tab and snap it next to the editor.",
  },
  tags: {
    name: "Tag label shown on posts (e.g. 'Machine Learning', 'Python')",
    description: "Optional short description shown on the tag archive page",
  },
  projects: {
    title: null,
    technology: "e.g. 'Python · LangChain · FastAPI' — shown as the accent label",
    url_link: "Live URL or GitHub repo link",
    featured: "Featured projects appear on the homepage",
    images: "Upload screenshots or demo images",
    description: "Full project description — supports Markdown",
  },
  pages: {
    title: "The page heading — also used as the browser tab title",
    permalink:
      "The URL path the page lives at. Convention is /pages/<slug>/, but you can use any path. Must start and end with a slash.",
    published: "ON = page goes live on the next deploy. Leave OFF to keep it as a draft.",
    body: "Page content. For a real-layout preview that updates on every Save, open /preview/?collection=pages in a second tab.",
  },
};

const LOCAL_HINTS = {
  posts: {
    title: null,
    slug: "URL path segment (leave blank to auto-generate from title). Must match any existing published URL to avoid breaking inbound links.",
    excerpt: null,
    featured_image: null,
    published:
      "ON = goes live on the next deploy. Leave OFF to schedule a future publish via the Publish Date below — the scheduled-posts workflow flips this toggle on when the date arrives.",
    publish_date:
      "Optional. Future date/time (UTC) to auto-publish this post. Only honoured when Published above is OFF — if Published is ON, the post goes live immediately and this field is ignored.",
    body: "Full post content. For a real-layout preview that updates on every Save, open /preview/?collection=posts in a second tab.",
  },
  tags: {
    name: null,
    description: null,
  },
  projects: {
    title: null,
    technology: null,
    url_link: null,
    featured: null,
    images: null,
    description: null,
  },
  pages: {
    title: null,
    permalink: null,
    published: null,
    body: null,
  },
};

const TEST_HINTS = {
  posts: {
    title: null,
    slug: null,
    excerpt: null,
    featured_image: null,
    published:
      "ON = goes live on the next deploy. Leave OFF to schedule a future publish via the Publish Date below.",
    publish_date: null,
    body: "Open /preview/?collection=posts in a second tab for the real-layout preview.",
  },
  tags: {
    name: null,
    description: null,
  },
  projects: {
    title: null,
    technology: null,
    url_link: null,
    featured: null,
    images: null,
    description: null,
  },
  pages: {
    title: null,
    permalink: null,
    published: null,
    body: null,
  },
};

const FIXTURES = [
  {
    file: path.join(REPO_ROOT, "admin/config.yml"),
    label: "admin/config.yml",
    expected: PROD_HINTS,
  },
  {
    file: path.join(REPO_ROOT, "admin/config-local.yml"),
    label: "admin/config-local.yml",
    expected: LOCAL_HINTS,
  },
  {
    file: path.join(REPO_ROOT, "admin/config-test.yml"),
    label: "admin/config-test.yml",
    expected: TEST_HINTS,
  },
];

test.describe(
  "Decap CMS form-clarity hint snapshots",
  // Tagged @admin-read: drives local /admin shell, no GitHub writes —
  // runs on chromium-desktop-3k + webkit-iphone16 only. See
  // playwright.config.js for the matrix routing contract.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial" });

    for (const { file, label, expected } of FIXTURES) {
      test(`${label}: every locked hint matches its expected literal`, () => {
        const cfg = parseConfig(file);
        const mismatches = [];
        for (const [collection, fields] of Object.entries(expected)) {
          for (const [field, expectedHint] of Object.entries(fields)) {
            const actual = hintFor(cfg, collection, field);
            if (actual !== expectedHint) {
              mismatches.push({
                path: `${collection}.${field}`,
                expected: expectedHint,
                actual,
              });
            }
          }
        }
        expect(
          mismatches,
          `Hint drift in ${label}:\n${mismatches
            .map(
              (m) =>
                `  - ${m.path}\n      expected: ${JSON.stringify(m.expected)}\n      actual:   ${JSON.stringify(m.actual)}`,
            )
            .join("\n")}`,
        ).toEqual([]);
      });
    }
  },
);
