// @lane: local — pure-fs lint on the ASCII, length-capped entry file names (#635)
//
// Decap's default `slug.encoding: unicode` kept an em dash, curly quotes,
// emoji and accented letters in entry file names and in the editorial branch
// `cms/<collection>/<slug>` named after them: the title
// "ZZ Exploratory test — delete me" became
// `_posts/2026-10-05-zz-exploratory-test-—-delete-me.md`, one page name
// reached 195 characters, and the Posts list (which matched branches with an
// ASCII-only pattern) showed such a draft as "Live". config.base.yml now sets
// the global `slug:` options to ASCII and caps each base collection's title
// segment with `| truncate(80, '-')`; this locks both in all three configs,
// read with a real YAML parser.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ADMIN = path.join(__dirname, "..", "theme", "admin");
const CONFIGS = ["config.base.yml", "config-local.base.yml", "config-test.yml"];
const BASE_COLLECTIONS = ["posts", "tags", "projects", "pages", "e2e"];

const SLUG_OPTIONS = { encoding: "ascii", clean_accents: true, sanitize_replacement: "-" };
const CAPPED = "{{slug | truncate(80, '-')}}";
const TEMPLATES = {
  posts: `{{year}}-{{month}}-{{day}}-${CAPPED}`,
  tags: CAPPED,
  projects: CAPPED,
  pages: CAPPED,
  e2e: CAPPED,
};

function read(name) {
  return fs.readFileSync(path.join(ADMIN, name), "utf8");
}

function loadDraftMedia() {
  const sandbox = { window: {}, URL };
  vm.createContext(sandbox);
  vm.runInContext(read("draft-media-fallback.js"), sandbox);
  return sandbox.window.CMSDraftMedia;
}

test.describe("Decap entry file names are ASCII-only and length-capped (#635)", () => {
  for (const name of CONFIGS) {
    test(`${name}: global slug options are ASCII with accents cleaned`, () => {
      const cfg = YAML.parse(read(name));
      expect(cfg.slug, `${name}: top-level slug options`).toEqual(SLUG_OPTIONS);
    });

    test(`${name}: every base collection caps its title segment at 80 characters`, () => {
      const cfg = YAML.parse(read(name));
      const present = (cfg.collections || []).filter((c) => c && BASE_COLLECTIONS.includes(c.name));
      // config-local and config-test carry no e2e collection; the other four
      // are in every config.
      expect(present.map((c) => c.name)).toEqual(expect.arrayContaining(["posts", "tags", "projects", "pages"]));
      for (const c of present) {
        expect(c.slug, `${name}: ${c.name}.slug`).toBe(TEMPLATES[c.name]);
      }
    });

    test(`${name}: admin/draft-media-fallback.js reads the same slug options`, () => {
      const parsed = loadDraftMedia().parseConfig(read(name));
      expect({ ...parsed.slug }).toEqual(SLUG_OPTIONS);
    });
  }

  // draft-media-fallback.js's normalizeUploadName is the platform's mirror
  // of Decap's sanitizeSlug (unit-tested against it in
  // draft-media-fallback.test.js); fed these options it shows what they do to
  // the issue's titles. The real Decap run happens only in a browser.
  test("the options turn an em dash, curly quotes, an emoji and accents into plain ASCII", () => {
    const n = (s) => loadDraftMedia().normalizeUploadName(s, SLUG_OPTIONS);
    expect(n("ZZ Exploratory test — delete me")).toBe("zz-exploratory-test-delete-me");
    expect(n("“Quoted” isn’t \u{1F680} Café naïve")).toBe("quoted-isn-t-cafe-naive");
  });
});
