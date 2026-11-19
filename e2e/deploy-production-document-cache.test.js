// @lane: local — parses the platform's own deploy-production.yml; pure fs
//
// Pages, feeds and the sitemap must not be cacheable by a browser or a feed
// reader for a day. Until 2026-11-19 the production deploy uploaded the whole
// site with `Cache-Control: public, max-age=86400`. A reader that fetched
// `feed.xml` before a post went live was entitled to keep that copy for 24
// hours: the owner's post was in the feed and missing from his own
// NetNewsWire, and a returning visitor's browser showed yesterday's home page.
//
// What this holds:
//   1. every DOCUMENT (html, xml, txt, json) is uploaded with a header that
//      makes clients revalidate, and nothing else is;
//   2. non-documents keep their day-long header;
//   3. the two passes' filters, evaluated the way `aws s3 sync` evaluates
//      them (in order, last match wins), send each file to exactly one pass
//      and keep `404.html` and `admin/*` out of both;
//   4. the edge may keep documents (`s-maxage`) only because a later step
//      invalidates `/*`.
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, awsCommands, flagValues, isLongCache, isUncacheable } = require("./workflow-yaml-utils");

const WORKFLOW = "deploy-production.yml";

const isSiteSync = (w) => w[1] === "s3" && w[2] === "sync" && /^(\.\/)?_site\/?$/.test(w[3] || "");

// The ordered --exclude / --include filters of one aws command.
function filters(words) {
  const out = [];
  words.forEach((w, i) => {
    if ((w === "--exclude" || w === "--include") && i + 1 < words.length) {
      out.push({ include: w === "--include", pattern: words[i + 1] });
    }
  });
  return out;
}

// `aws s3 sync` filter semantics: every file starts included, filters apply
// in order, the last one that matches decides. `*` matches any characters,
// `/` included; `?` one character.
function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}
function selects(fs, key) {
  let included = true;
  for (const f of fs) if (globToRegExp(f.pattern).test(key)) included = f.include;
  return included;
}

function siteSyncs() {
  const root = parseYaml(readWorkflow(WORKFLOW));
  const found = [];
  for (const [jobName, job] of Object.entries(root.jobs || {})) {
    (job.steps || []).forEach((step, index) => {
      for (const words of awsCommands(step && step.run)) {
        if (isSiteSync(words)) found.push({ jobName, index, steps: job.steps, words });
      }
    });
  }
  return found;
}

const DOCUMENTS = [
  "index.html",
  "feed.xml",
  "sitemap.xml",
  "robots.txt",
  "blog/index.html",
  "blog/quoting-dean-ball/index.html",
  "tags/ai/feed.xml",
  "tools/claude-memory-map/index.html",
  "assets/tools/claude-memory-map/data.json",
];
const ASSETS = [
  "assets/css/main.css",
  "assets/js/site.js",
  "assets/images/uploads/img_2020.jpeg",
  "assets/images/logo.svg",
  "favicon.ico",
  "assets/fonts/inter.woff2",
  "assets/files/paper.pdf",
];
const NEITHER = ["404.html", "admin/index.html", "admin/config.yml", "admin/commit.json", "admin/reviews/index.html"];

test.describe("deploy-production: documents revalidate, assets cache", () => {
  const syncs = siteSyncs();
  const cacheOf = (s) => flagValues(s.words, "--cache-control");
  const long = syncs.filter((s) => cacheOf(s).some(isLongCache));
  const docs = syncs.filter((s) => cacheOf(s).some(isUncacheable));

  test("the site is uploaded in exactly two passes, one long-cached and one that revalidates", () => {
    expect(syncs).toHaveLength(2);
    expect(long).toHaveLength(1);
    expect(docs).toHaveLength(1);
    expect(long[0]).not.toBe(docs[0]);
    for (const s of syncs) {
      expect(cacheOf(s), "one Cache-Control per pass").toHaveLength(1);
      expect(s.words, "each pass prunes what its filters cover").toContain("--delete");
    }
  });

  test("the document pass makes clients revalidate and lets only the edge keep a copy", () => {
    const value = cacheOf(docs[0])[0].toLowerCase();
    const directives = value.split(",").map((d) => d.trim());
    expect(directives).toContain("public");
    expect(directives).toContain("max-age=0");
    expect(directives).toContain("must-revalidate");
    const smax = directives.find((d) => d.startsWith("s-maxage="));
    expect(smax, "an edge TTL, so CloudFront does not hit S3 on every request").toBeTruthy();
    expect(Number(smax.split("=")[1])).toBeGreaterThan(0);
    expect(value).not.toMatch(/no-store/);
  });

  test("every document goes to the revalidating pass only, every asset to the long-cached pass only", () => {
    const inLong = (k) => selects(filters(long[0].words), k);
    const inDocs = (k) => selects(filters(docs[0].words), k);
    for (const k of DOCUMENTS) {
      expect(inDocs(k), `${k} must be uploaded by the document pass`).toBe(true);
      expect(inLong(k), `${k} must NOT get the day-long header`).toBe(false);
    }
    for (const k of ASSETS) {
      expect(inLong(k), `${k} must be uploaded by the long-cached pass`).toBe(true);
      expect(inDocs(k), `${k} must not be in the document pass`).toBe(false);
    }
    for (const k of NEITHER) {
      expect(inLong(k), `${k} is uploaded by its own no-cache step, not here`).toBe(false);
      expect(inDocs(k), `${k} is uploaded by its own no-cache step, not here`).toBe(false);
    }
  });

  test("the filter evaluation here is the CLI's: order matters and the last match wins", () => {
    // The trap this layout avoids: with the excludes BEFORE the includes,
    // `--include '*.html'` would put 404.html and admin/ back.
    const wrong = [
      { include: false, pattern: "*" },
      { include: false, pattern: "404.html" },
      { include: false, pattern: "admin/*" },
      { include: true, pattern: "*.html" },
    ];
    expect(selects(wrong, "404.html")).toBe(true);
    expect(selects(wrong, "admin/index.html")).toBe(true);
    expect(selects([], "anything")).toBe(true);
    expect(selects([{ include: false, pattern: "*.html" }], "blog/x/index.html")).toBe(false);
  });

  test("the edge copy is safe only because a later step invalidates everything", () => {
    const { steps, index } = docs[0];
    const invalidates = steps.slice(index + 1).some((s) =>
      awsCommands(s && s.run).some(
        (w) => w[1] === "cloudfront" && w[2] === "create-invalidation" && flagValues(w, "--paths").includes("/*"),
      ),
    );
    expect(invalidates, "a `cloudfront create-invalidation --paths '/*'` after the upload").toBe(true);
  });
});
