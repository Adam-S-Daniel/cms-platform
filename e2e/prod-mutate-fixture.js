/*
 * Pure builders for the EPHEMERAL, born-published, hard-deleted per-run
 * prod-loop posts (#1771 step 4).
 *
 * Why this module exists
 * ----------------------
 * The prod-mutation (`cms-publish-loop-prod-mutate.spec.js`) and media
 * round-trip (`cms-media-roundtrip.spec.js`) loops used to mutate a
 * single PERSISTENT committed `_posts/` fixture in place — toggle
 * `published`, edit the body, then revert. A transient failure on the
 * revert leg left that one shared cell corrupted on `main`, and because
 * the next run re-derived its baseline from the same on-disk body, the
 * corruption was self-perpetuating (#1771 incident run 26511130712).
 *
 * Step 4 removes the *class* of bug by construction: each run now
 * CREATES a uniquely-pathed post, publishes it, asserts it serves, then
 * DELETES it — resting state is ABSENCE (404), and absence has no
 * corrupt variant. A killed run leaks at most ONE inert, uniquely-named
 * orphan (swept by `sweep-stale-cms-prs.yml`), never a shared mutable
 * baseline. The path/body are a pure function of the runId; nothing ever
 * reads a path it also writes (the #1771 invariant).
 *
 * Born-published + future-dated (the canonical `composePost` text):
 *   - `published: true` from creation — the loop never toggles a
 *     persistent file; it creates a live post and deletes it.
 *   - date `2099-12-31` so the post serves the SAME way the old
 *     `2099-01-01` canary did under `_config.yml`'s `future: true`
 *     (Jekyll skips future-dated posts unless `future: true`; the old
 *     canaries relied on exactly that). `2099-12-31` sorts last and is
 *     trivially unique-by-runId in the slug, so it can't collide with a
 *     real post or another in-flight run.
 *   - `robots: noindex,nofollow` + `sitemap: false` so a born-published
 *     post that briefly serves mid-run never leaks into search.
 *   - `test_fixture: true` so `admin/posts-list-enhance.js` hides it
 *     from the Posts list by default (issue #1042), exactly like the old
 *     committed canaries.
 *
 * IMPORTANT — what the LIVE post actually carries vs this text. The
 * `composePost` front matter above is the canonical/intended shape, and
 * it's what the afterAll harness-hygiene fallback writes (via
 * `removeFixtureViaPr` it's a DELETE, but a future seed path would use
 * this text). The PRIMARY create leg, however, is genuinely UI-driven —
 * the spec types Title/URL Slug/Date/Body into Decap's "+ New Post" form
 * and toggles Published. Decap writes ONLY the fields the `posts`
 * collection declares (admin/config*.yml), which does NOT include
 * `sitemap`/`robots`, and whose `test_fixture` is `widget: hidden,
 * default: false` — a hidden widget the editor can't toggle. So the post
 * that actually lands on `main` from the UI carries `published: true`,
 * the future date, `test_fixture: false`, and NO `sitemap`/`robots`
 * keys. That is why the public-content @parity crawls cannot rely on
 * `test_fixture: true` / `sitemap: false` to exclude these canaries and
 * key on the structural `e2e-` slug signature instead — see
 * e2e/public-content.js (`isTestFixturePost`). The `slug:`/`date:` the
 * spec types are reliably present, so the signature is robust.
 *
 * The body marker IS the runId (structural, in the slug AND the body) so
 * a Slate `widget: markdown` round-trip on the body can't strip the
 * run-identity the assertions match on — and since the post is deleted,
 * any body churn is thrown away with it.
 *
 * Pure Node — no `require("./base")` — so it stays a plain, unit-testable
 * library (same discipline as `./fixture-baseline`).
 */

// Future date the ephemeral posts carry. Sorts last among `_posts/` and
// serves only because `_config.yml` sets `future: true` (the same
// mechanism the retired `2099-01-01` / `2099-01-03` canaries used).
const EPHEMERAL_DATE = "2099-12-31";

// Slug prefixes — the orphan sweeper tier and the recursion-churn glob
// both key off these, so they are exported (single source of truth).
const PROD_MUTATE_SLUG_PREFIX = "e2e-prod-mutate";
const MEDIA_ROUNDTRIP_SLUG_PREFIX = "e2e-media-roundtrip";

// Build the per-run ephemeral prod-mutate post.
//
// Returns the slug, the on-disk file path, the public URL path, the
// post Title, and the full canonical file text (front matter + body),
// all a pure function of `runId`. The runId appears in BOTH the slug and
// the body so it survives a Slate body round-trip and disambiguates this
// run's PR / URL from any other run's.
function buildProdMutatePost({ runId } = {}) {
  if (runId == null || `${runId}`.length === 0) {
    throw new Error("buildProdMutatePost requires a runId.");
  }
  const slug = `${PROD_MUTATE_SLUG_PREFIX}-${runId}`;
  const filePath = `_posts/${EPHEMERAL_DATE}-${slug}.md`;
  const publicPath = `/blog/${slug}/`;
  const title = `E2E Prod Mutate ${runId}`;
  const marker = `${PROD_MUTATE_SLUG_PREFIX}:${runId}`;
  const body =
    `Adam Daniel — ephemeral E2E prod-mutate canary (run ${runId}; do not edit by hand).\n\n` +
    `This post is CREATED, published, asserted live, then DELETED within a ` +
    `single run of \`e2e/cms-publish-loop-prod-mutate.spec.js\`. Its resting ` +
    `state is absence (404). The run marker is ${marker}.\n`;
  const fileText = composePost({ title, slug, body, featuredImage: "" });
  return { runId, slug, filePath, publicPath, title, marker, body, fileText };
}

// Build the per-run ephemeral media round-trip post. Analogous to the
// prod-mutate post but for the media spec; the per-run uploaded image is
// attached/removed by the spec (its name is independently unique).
function buildMediaRoundtripPost({ runId } = {}) {
  if (runId == null || `${runId}`.length === 0) {
    throw new Error("buildMediaRoundtripPost requires a runId.");
  }
  const slug = `${MEDIA_ROUNDTRIP_SLUG_PREFIX}-${runId}`;
  const filePath = `_posts/${EPHEMERAL_DATE}-${slug}.md`;
  const publicPath = `/blog/${slug}/`;
  const title = `E2E Media Roundtrip ${runId}`;
  const marker = `${MEDIA_ROUNDTRIP_SLUG_PREFIX}:${runId}`;
  const body =
    `Adam Daniel — ephemeral E2E media round-trip canary (run ${runId}; do not edit by hand).\n\n` +
    `This post is CREATED with a per-run uploaded image, asserted live, then ` +
    `the image and the post are DELETED within a single run of ` +
    `\`e2e/cms-media-roundtrip.spec.js\`. Its resting state is absence (404). ` +
    `The run marker is ${marker}.\n`;
  const fileText = composePost({ title, slug, body, featuredImage: "" });
  return { runId, slug, filePath, publicPath, title, marker, body, fileText };
}

// Compose the full `_posts/` file text the editor would produce for a
// born-published ephemeral canary. Used by the afterAll safety-net's
// fixture-PR fallback (the primary create leg is UI-driven). Front
// matter mirrors the shape Decap writes for the posts collection.
function composePost({ title, slug, body, featuredImage = "" }) {
  const frontMatter = [
    "---",
    `title: ${title}`,
    `slug: ${slug}`,
    `date: ${EPHEMERAL_DATE} 00:00:00 +0000`,
    "tags: []",
    `featured_image: ${featuredImage ? JSON.stringify(featuredImage) : '""'}`,
    "published: true",
    "robots: noindex,nofollow",
    "sitemap: false",
    'publish_date: ""',
    "test_fixture: true",
    "---",
  ].join("\n");
  return `${frontMatter}\n${body}`;
}

module.exports = {
  EPHEMERAL_DATE,
  PROD_MUTATE_SLUG_PREFIX,
  MEDIA_ROUNDTRIP_SLUG_PREFIX,
  buildProdMutatePost,
  buildMediaRoundtripPost,
  composePost,
};
