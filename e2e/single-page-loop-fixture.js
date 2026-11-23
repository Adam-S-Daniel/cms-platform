/*
 * Pure builders and checks for the single-page publish loop (#1068).
 *
 * A single-page consumer (`cms.base_collections: []`, jodidaniel.com) has no
 * `posts` or `e2e` collection, so every publish loop that drives them
 * self-skips there. `cms-publish-loop-single-page.spec.js` publishes through
 * the site's OWN collections instead:
 *
 *   Leg A: a `media` folder-collection entry (create, publish, delete).
 *   Leg B: one field of one `_data/*.yml` file collection entry (edit,
 *          publish, restore).
 *
 * Everything a run names (title, slug, file path, branch, public path, the
 * edited value) is a pure function of the run id, so the spec and its
 * unit test agree on it. Pure Node, no `require("./base")`: a plain library,
 * like ./prod-mutate-fixture.js.
 *
 * The values are constrained by what the consumer's own verifier accepts
 * (jodidaniel.com issues 338 and 339): a media title is plain ASCII (an em
 * dash fails site-verify) and `date_display` is never blank.
 */
const YAML = require("yaml");

const SINGLE_PAGE_SLUG_PREFIX = "e2e-publish-loop";

// The `weight` the throw-away media item carries. Decap's media slug template
// is `{{weight}}-{{slug}}`, so it is also the file name's prefix.
const MEDIA_WEIGHT = 99;

// Month and year as the editor field's hint asks ("April 2025"). Far-future so
// it can never read as a real appearance if the page ever shows it.
const MEDIA_DATE_DISPLAY = "December 2099";
const MEDIA_CATEGORY = "Articles & Commentary";
const MEDIA_SOURCE = "E2E publish loop";

// The media front-matter markers that make an item disposable. The media
// collection declares no widget for it, so the spec stamps it with a Decap
// `preSave` listener (cms-editor-ui.js markEphemeralMediaItem), the way posts
// get TEST_POST_MARKERS.
const TEST_MEDIA_MARKERS = Object.freeze({ test_fixture: true });

// Leg B's target: the contact section's heading. Plain text, not rendered
// while the site is gated, and the file holds no comments for Decap to drop.
const DATA_TARGET = Object.freeze({
  collection: "site_contact",
  entry: "contact",
  filePath: "_data/contact.yml",
  field: "heading",
  fieldLabel: "Heading",
  navLabel: "Contact",
});

function requireRunId(runId, who) {
  if (runId == null || `${runId}`.length === 0) {
    throw new Error(`${who} requires a runId.`);
  }
  return `${runId}`;
}

// Plain printable ASCII only: no em dash, no curly quote, no control byte.
function isPlainAscii(text) {
  return typeof text === "string" && /^[\x20-\x7e]*$/.test(text);
}

// The Decap slug for a title: lower case, runs of other characters become one
// dash. Enough for the ASCII, alphanumeric titles built here.
function slugifyTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Everything Leg A needs, a pure function of `runId`.
function buildSinglePageMedia({ runId } = {}) {
  const id = requireRunId(runId, "buildSinglePageMedia");
  const title = `E2E publish loop ${id}`;
  const slug = slugifyTitle(title);
  const fileSlug = `${MEDIA_WEIGHT}-${slug}`;
  return {
    runId: id,
    title,
    slug,
    fileSlug,
    filePath: `_media/${fileSlug}.md`,
    // Decap's editorial branch for a folder entry is cms/<collection>/<file slug>.
    branch: `cms/media/${fileSlug}`,
    entryPath: `/collections/media/entries/${fileSlug}`,
    // _config.yml: media is `output: true` with permalink /media/:slug/.
    publicPath: `/media/${fileSlug}/`,
    fields: {
      category: MEDIA_CATEGORY,
      source: MEDIA_SOURCE,
      date_display: MEDIA_DATE_DISPLAY,
      article_url: `https://example.com/e2e-publish-loop/${id}`,
      weight: MEDIA_WEIGHT,
    },
  };
}

// The strings a gated page must not leak: the item's own title, source and
// outbound link. While `site_live` is false only the coming-soon shell renders.
function leakMarkers(media) {
  return [media.title, media.fields.article_url];
}

// Does the page text carry any of the item's own copy?
function leakedMarkers(pageText, media) {
  const text = String(pageText);
  return leakMarkers(media).filter((m) => text.includes(m));
}

// The media front-matter keys that are missing or wrong: the TEST_MEDIA_MARKERS
// plus the values the spec typed. An empty list means the file Decap committed
// is exactly what the spec meant to publish. Front matter that does not parse
// is missing everything.
function missingMediaFields(fileText, media) {
  let data = null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(fileText));
  if (match) {
    try {
      data = YAML.parse(match[1]);
    } catch {
      data = null;
    }
  }
  const present = data && typeof data === "object" ? data : {};
  const want = { ...TEST_MEDIA_MARKERS, title: media.title, ...media.fields };
  return Object.entries(want)
    .filter(([key, value]) => present[key] !== value)
    .map(([key]) => key);
}

// Leg B: the value read back from a data file's text, or undefined when the
// file does not parse to a mapping or lacks the field.
function readDataField(fileText, field) {
  let data;
  try {
    data = YAML.parse(String(fileText));
  } catch {
    return undefined;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data[field] : undefined;
}

// The edited value for Leg B: the original with a run marker appended, plain
// ASCII, and never equal to the original.
function buildEditedValue({ original, runId } = {}) {
  const id = requireRunId(runId, "buildEditedValue");
  if (typeof original !== "string" || original.length === 0) {
    throw new Error("buildEditedValue requires the original field value (a non-empty string).");
  }
  return `${original} e2e ${id}`;
}

// Do two data files hold the same data? Decap re-serializes a file it saves
// (flow lists become block lists, quoting changes), so the restore check is on
// the parsed value, never the bytes. Unparseable text is never "the same".
function sameData(a, b) {
  try {
    return JSON.stringify(YAML.parse(String(a))) === JSON.stringify(YAML.parse(String(b)));
  } catch {
    return false;
  }
}

// The loop's own self-churn globs (cms-recursion-churn.js `host`).
const SELF_CHURN_GLOBS = Object.freeze([`_media/${MEDIA_WEIGHT}-${SINGLE_PAGE_SLUG_PREFIX}-*.md`]);

module.exports = {
  SINGLE_PAGE_SLUG_PREFIX,
  MEDIA_WEIGHT,
  MEDIA_DATE_DISPLAY,
  MEDIA_CATEGORY,
  MEDIA_SOURCE,
  TEST_MEDIA_MARKERS,
  DATA_TARGET,
  SELF_CHURN_GLOBS,
  isPlainAscii,
  slugifyTitle,
  buildSinglePageMedia,
  leakMarkers,
  leakedMarkers,
  missingMediaFields,
  readDataField,
  buildEditedValue,
  sameData,
};
