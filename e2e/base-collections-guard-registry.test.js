// @lane: local — PURE-FS guard-registry lint (NO Jekyll build, NO browser).
//
// THE #33 PLATFORM-CI GUARD (CONCERN B). The build-and-run proof
// (base-collections-skip-meta.test.js) BUILDS both fixtures, so it lives in the
// node-unit-lints DENY list + PLATFORM_META_SPECS and NO platform PR-gating lane
// actually runs it — a regression in the admin-write skip-guards would merge
// unnoticed. This lint is the lightweight, build-free protection that DOES run
// in self-ci.yml's node-unit-lints lane (it's a hermetic *.test.js: pure-fs
// reads of the two fixtures' _config.yml + the spec source — no page.goto, no
// _site). It makes the guard set RED-on-drift in three ways:
//
//   (1) PREDICATE PROOF — for every registered admin-write spec, the registry's
//       skip predicate (build-INDEPENDENT keep-list source signal) resolves
//       SKIP on the opted-out fixture and RUN on the full fixture. This is the
//       both-directions proof the build-and-run meta-test gives, but evaluated
//       at the PREDICATE level against the real fixtures' _config.yml — so it
//       needs no Jekyll. If a guard's collection mapping drifts, this goes RED.
//
//   (2) GUARD-PRESENCE — every registered spec's SOURCE actually applies its
//       inline base_collections guard (imports base-collections-guards and
//       calls guard()/shouldSkip() with its own basename, tagged "(#33)"). If
//       someone deletes a guard but leaves the registry entry, this goes RED.
//
//   (3) NO SILENT DRIFT — every CONSUMER-RUNNING spec (target:local, NOT in
//       playwright.config.js PLATFORM_META_SPECS) that DEPENDS ON A BASE
//       COLLECTION EXISTING is EITHER guarded (registry guard OR a direct inline
//       hasAdminCollection/keepsBaseCollection skip) OR in the explicit
//       NON_GUARDED allowlist (with a documented reason). A NEW unguarded
//       base-collection-dependent spec turns this RED — the guard set cannot
//       silently drift.
//
//       The detector is COMPREHENSIVE — it covers EVERY class of base-collection
//       dependence a consumer-running spec can carry, not just index-local
//       navigation (the original blind spot that let cms-preview-url.spec.js +
//       cms-form-clarity.spec.js slip through unguarded):
//
//         CLASS A  index-local route — page.goto(...index-local.html#/collections/<base>)
//         CLASS B  index-local sidebar wait — getByRole("link",{name:/^<base>$/i})
//                  in a file that loads index-local.html but NOT index-test.html
//         CLASS C  rendered-config per-base-collection read — reads the rendered
//                  _site/admin/config.yml (RENDERED_CONFIG / hasAdminCollection /
//                  adminCollections) AND makes a per-base-collection assertion
//                  against it: preview_path, a field-hint snapshot (hintFor /
//                  PROD_HINTS / hint:), findCollection(cfg,'<base>'), or
//                  hasAdminCollection(siteRoot,'<base>') for a named base.
//
//       A spec whose admin shell is index-test.html (config-test.yml is FIXED —
//       NOT subject to the base_collections keep-list deletion) is NOT flagged by
//       CLASS A/B; those specs must NOT be guarded. The base-CONTENT readers
//       (_posts/_e2e/sitemap/feeds/tags served-site specs) are covered by their
//       own site-capabilities self-skips + the build-and-run meta proof and are
//       allowlisted here when they surface a rendered-config signal.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const reg = require("./base-collections-guards");
const cap = require("./site-capabilities");

const HARNESS = __dirname;
const FULL = path.join(HARNESS, "fixture-site");
const SINGLEPAGE = path.join(HARNESS, "fixture-site-singlepage");
// Nav classes (A/B) only ever wait on / route to the four editable base
// collections; the rendered-config class (C) can also touch `e2e`.
const NAV_BASE = ["posts", "tags", "projects", "pages"];
const ALL_BASE = ["posts", "tags", "projects", "pages", "e2e"];

// Consumer-running specs the COMPREHENSIVE detector flags (they touch a base
// collection by one of CLASS A/B/C) but that DON'T apply any recognized guard
// AND genuinely don't need one, each with WHY. The drift lint allows exactly
// these; anything else flagged-but-unguarded goes RED.
//
// EMPTY by design: every spec the comprehensive detector flags is covered
// either by a registry guard (group-2 index-local specs) or a direct inline
// cap.hasAdminCollection / cap.keepsBaseCollection self-skip (the rendered-
// config readers: cms-config, cms-permalink-contract, cms-post-list-summary,
// cms-preview-url, cms-form-clarity). If you add a flagged spec that truly
// needs NO guard (e.g. it asserts ABSENCE, which stays correct/empty on an
// opted-out consumer), add it here with a reason — the stale-entry test below
// will require it to be genuinely flagged-but-unguarded so the allowlist can't
// rot into a dumping ground.
const NON_GUARDED = {};

// Re-read the canonical PLATFORM_META_SPECS list from playwright.config.js (the
// single source of truth for "not consumer-running"), so this lint and the
// runner agree without a second copy.
function platformMetaSpecs() {
  const cfg = fs.readFileSync(path.join(HARNESS, "playwright.config.js"), "utf8");
  const m = cfg.match(/PLATFORM_META_SPECS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("could not locate PLATFORM_META_SPECS in playwright.config.js");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

// ── The COMPREHENSIVE detector ───────────────────────────────────────────
//
// Return the list of base-collection-dependence CLASSES a consumer-running
// spec SOURCE carries (empty ⇒ the spec doesn't depend on a base collection
// existing, so it needs no guard). EVERY class that breaks on a
// base_collections:[] consumer is covered — not just index-local navigation
// (the original blind spot). See the file header for the class catalogue.
function baseCollectionClasses(src) {
  const classes = [];

  // CLASS A — index-local route hash to a base collection.
  if (
    NAV_BASE.some((c) => new RegExp(`index-local\\.html#/collections/${c}\\b`).test(src))
  ) {
    classes.push("index-local-route");
  }

  // CLASS B — base-collection sidebar-link wait, but ONLY when the file loads
  // index-local AND never loads index-test (index-test → config-test.yml is
  // FIXED, not opted-out, so those specs must NOT be guarded).
  const loadsIndexLocal = /page\.goto\(\s*["']\/admin\/index-local\.html/.test(src);
  const loadsIndexTest = /page\.goto\(\s*["']\/admin\/index-test\.html/.test(src);
  if (loadsIndexLocal && !loadsIndexTest) {
    const sidebarWait = NAV_BASE.some((c) =>
      new RegExp(`getByRole\\(\\s*["']link["']\\s*,\\s*\\{\\s*name:\\s*/\\^${c}\\$/i`).test(src),
    );
    if (sidebarWait) classes.push("index-local-sidebar");
  }

  // CLASS C — reads the RENDERED admin config AND makes a per-base-collection
  // assertion against it. This is the class that caught cms-preview-url +
  // cms-form-clarity: on a base_collections:[] consumer the posts/tags/projects/
  // pages block is STRIPPED from the rendered config, so a preview_path
  // toContain / field-hint snapshot / findCollection('<base>') reads
  // null/absent and the spec FAILS. We require BOTH the rendered-config read
  // AND a per-base assertion so a spec that merely reads the rendered config
  // for a config-AGNOSTIC top-level key (media_folder, site_url, publish_mode,
  // backend.branch — e.g. cms-config-preview-delta) is NOT falsely flagged.
  const readsRenderedConfig =
    /RENDERED_CONFIG\b/.test(src) ||
    // `_site/admin/config.yml` written as a path (slashes or path.join parts).
    /_site["',\s/]+admin["',\s/]+config\.yml/.test(src) ||
    /renderedAdminConfigPath\(|adminCollections\(/.test(src);
  if (readsRenderedConfig) {
    const perBase =
      /preview_path/.test(src) ||
      /hintFor\(|PROD_HINTS|LOCAL_HINTS|TEST_HINTS/.test(src) ||
      ALL_BASE.some((c) =>
        new RegExp(`findCollection\\([^)]*["']${c}["']`).test(src),
      ) ||
      ALL_BASE.some((c) =>
        new RegExp(`hasAdminCollection\\([^)]*["']${c}["']`).test(src),
      );
    if (perBase) classes.push(`rendered-config-per-collection`);
  }

  // CLASS D — single-page-SURFACE dependence (#21). A consumer-running spec that
  // drives a surface / data that a `base_collections:[]` single-page bio
  // GENUINELY lacks — NOT an index-local route (A/B) or a per-collection
  // rendered-config read (C), but one of:
  //
  //   D1 reviews-dashboard — page.goto(.../admin/reviews[/...]). The /admin/
  //      reviews/ + reviews/health.html QA dashboards summarise the CMS publish-
  //      loop / visual-regression review of CONTENT a single-page bio has none of.
  //   D2 preview-collection-variants — drives /preview/ AND asserts a
  //      per-collection variant (?collection=pages|projects OR
  //      data-preview-layout="pages"|"projects"). A single-page consumer ships no
  //      preview.md (the shell 404s) + has no per-collection content to stream.
  //   D3 canary-readonly — the @canary-readonly probe GETs the rendered
  //      `/e2e/canary-*/` URLs (CANARIES[].publicPath); a consumer with no
  //      `_e2e/canary-*.md` source renders none, so they 404.
  //   D4 posts-draft-write — writes a `_posts/*.md` draft + asserts the
  //      `/blog/<slug>/` posts surface (draft-isolation); a base_collections:[]
  //      consumer ships no posts collection / `/blog/`.
  //
  // Each pattern is PRECISE — it requires the surface-driving signal itself, so
  // a spec that merely navigates "/" (glow-banding, console-clean) or reads a
  // config-agnostic key is NOT flagged. These specs carry a coarse capability
  // guard (CAPABILITY_GUARDS' isSinglePage / hasE2ECanaries, recognized by
  // appliesBaseCollectionGuard) rather than a per-collection one.
  // D1 — drives /admin/reviews AND asserts the review-DATA surface (the health
  // workflow tiles / the visual-diff stat grid / regression.json). REQUIRING the
  // data signal excludes admin-reviews-auth.spec.js, which navigates the same
  // dashboard but only exercises the site-AGNOSTIC OAuth handshake (#auth-screen)
  // — it has no review subject matter to depend on, so it must NOT be guarded.
  const drivesReviews = /page\.goto\(\s*["']\/admin\/reviews(\/|["'])/.test(src);
  if (drivesReviews) {
    const readsReviewData =
      /\.health-card\b/.test(src) ||
      /\.stat-grid\b|\.review-card\b|stat-pages/.test(src) ||
      /WORKFLOW_FILES\b|regression\.json/.test(src);
    if (readsReviewData) classes.push("reviews-dashboard");
  }

  // D2 — actually NAVIGATES /preview/ to a per-collection variant (or asserts the
  // pages/projects variant DOM renders). REQUIRING the navigation excludes
  // preview-bridge.spec.js, which only regex-matches the URL its builder helper
  // returns (`adamdaniel_cms_preview_url("pages")` → …?collection=pages) without
  // navigating to or rendering that variant — site-agnostic, must NOT be guarded.
  const navigatesPreviewVariant =
    /page\.goto\(\s*["']\/preview\/\?collection=(pages|projects)\b/.test(src) ||
    /expect\([^)]*data-preview-layout="(pages|projects)"/.test(src);
  if (navigatesPreviewVariant) classes.push("preview-collection-variants");

  const probesCanary =
    /@canary-readonly/.test(src) ||
    (/require\(["']\.\/canary-content["']\)/.test(src) && /\.publicPath\b/.test(src));
  if (probesCanary) classes.push("canary-readonly");

  // D4 — writes a `_posts/*.md` source draft AND asserts the `/blog/` posts
  // surface. The `_posts` write distinguishes draft-isolation (which mutates the
  // posts collection) from absence-only readers like sitemap.spec.
  const writesPostsDraft =
    /["'`]_posts["'`]/.test(src) && /\/blog\//.test(src) && /writeFileSync|writeDraft/.test(src);
  if (writesPostsDraft) classes.push("posts-draft-write");

  return classes;
}

// Back-compat alias — the original narrow predicate is now CLASS A∪B of the
// comprehensive detector. Kept so any external reference still resolves.
function drivesIndexLocalBaseCollection(src) {
  return baseCollectionClasses(src).some(
    (c) => c === "index-local-route" || c === "index-local-sidebar",
  );
}

// Does a spec SOURCE apply a RECOGNIZED base_collections guard — EITHER the
// registry guard (imports base-collections-guards + calls guard()/shouldSkip())
// OR a direct inline self-skip keyed on a site-capability predicate
// (cap.hasAdminCollection / cap.keepsBaseCollection inside a test.skip)? Both
// styles are legitimate: the index-local group-2 specs use the registry; the
// rendered-config readers (cms-config, cms-permalink-contract, cms-preview-url,
// cms-form-clarity, …) self-skip directly on hasAdminCollection. A flagged spec
// applying EITHER is covered — it can't red-fail a base_collections:[] consumer.
function appliesBaseCollectionGuard(src) {
  const registryGuard =
    /require\(["']\.\/base-collections-guards["']\)/.test(src) &&
    /\b(guard|shouldSkip)\s*\(/.test(src);
  const directGuard =
    /test\.skip\(/.test(src) &&
    /\b(hasAdminCollection|keepsBaseCollection|isSinglePageConsumer)\s*\(/.test(src);
  return registryGuard || directGuard;
}

test.describe("#33 base_collections guard registry — predicate proof", () => {
  // (1) Both-directions predicate proof, per registered spec, against the REAL
  // fixtures' _config.yml. No build needed — the keep-list is a source read.
  for (const specName of reg.GUARDED_SPEC_NAMES) {
    test(`${specName}: SKIPS on opted-out fixture, RUNS on full fixture`, () => {
      expect(
        reg.shouldSkip(SINGLEPAGE, specName),
        `${specName} must SKIP on the base_collections:[] fixture (its collection is stripped from config-local.yml)`,
      ).toBe(true);
      expect(
        reg.shouldSkip(FULL, specName),
        `${specName} must RUN on the full fixture (the skip must never mask a real failure on a full consumer)`,
      ).toBe(false);
    });
  }

  // The registry's per-spec collection mapping must reference only real base
  // collection names, and the predicate must agree with keepsBaseCollection.
  test("every registered collection is a real base collection name", () => {
    for (const [specName, entry] of Object.entries(reg.ADMIN_WRITE_GUARDS)) {
      for (const c of entry.collections) {
        expect(
          cap.BASE_COLLECTION_NAMES,
          `${specName} registers unknown collection "${c}"`,
        ).toContain(c);
      }
      expect(["all", "any"], `${specName} has an invalid mode`).toContain(entry.mode);
      expect(entry.reason, `${specName} skip reason must cite (#33)`).toContain("(#33)");
    }
  });

  // Every CAPABILITY_GUARDS entry (#21) must reference a KNOWN capability
  // predicate and carry a reason that cites the issue, so the coarse single-
  // page guards stay as machine-checked as the per-collection ones.
  test("every capability guard references a known predicate and cites (#21)", () => {
    for (const [specName, entry] of Object.entries(reg.CAPABILITY_GUARDS)) {
      expect(
        Object.keys(reg.CAPABILITY_PREDICATES),
        `${specName} references unknown capability predicate "${entry.predicate}"`,
      ).toContain(entry.predicate);
      expect(entry.reason, `${specName} skip reason must cite (#21)`).toContain("(#21)");
    }
  });

  // A spec is guarded by EXACTLY ONE registry (a per-collection keep-list guard
  // OR a coarse capability guard) — never both, so shouldSkip()'s dispatch is
  // unambiguous.
  test("ADMIN_WRITE_GUARDS and CAPABILITY_GUARDS are disjoint", () => {
    const both = Object.keys(reg.ADMIN_WRITE_GUARDS).filter((n) =>
      Object.keys(reg.CAPABILITY_GUARDS).includes(n),
    );
    expect(both, "specs registered in BOTH ADMIN_WRITE_GUARDS and CAPABILITY_GUARDS").toEqual([]);
  });
});

test.describe("#33 base_collections guard registry — guard presence", () => {
  // (2) Each registered spec's SOURCE must actually apply its inline guard:
  // import the registry helper and call guard()/shouldSkip() with its own
  // basename. Catches "registry entry kept, guard deleted".
  for (const specName of reg.GUARDED_SPEC_NAMES) {
    test(`${specName} applies its inline base_collections guard`, () => {
      const file = path.join(HARNESS, specName);
      expect(fs.existsSync(file), `${specName} is registered but does not exist`).toBe(true);
      const src = fs.readFileSync(file, "utf8");
      expect(
        /require\(["']\.\/base-collections-guards["']\)/.test(src),
        `${specName} must require ./base-collections-guards`,
      ).toBe(true);
      // It must call guard()/shouldSkip() referencing its OWN basename, so the
      // guard can't be wired to the wrong spec's predicate.
      const callsGuard = new RegExp(
        `(guard|shouldSkip)\\([^)]*["']${specName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      ).test(src);
      expect(
        callsGuard,
        `${specName} must call guard()/shouldSkip() with its own basename "${specName}"`,
      ).toBe(true);
      // And it must self-skip on the result (test.skip referencing the guard).
      expect(
        /test\.skip\(/.test(src),
        `${specName} must test.skip() on the guard result`,
      ).toBe(true);
    });
  }
});

// The set of consumer-running specs the comprehensive detector flags, with
// their classes — computed once, reused by the drift assertions below.
function flaggedConsumerSpecs() {
  const meta = platformMetaSpecs();
  const out = [];
  for (const f of fs.readdirSync(HARNESS)) {
    if (!f.endsWith(".spec.js")) continue;
    if (meta.has(f)) continue; // not consumer-running
    if (f === "regression-video.spec.js") continue; // always-ignored generator
    const src = fs.readFileSync(path.join(HARNESS, f), "utf8");
    const classes = baseCollectionClasses(src);
    if (classes.length) out.push({ name: f, classes, src });
  }
  return out;
}

test.describe("#33 base_collections guard registry — no silent drift", () => {
  // (3) THE COMPREHENSIVE drift gate. Every consumer-running spec that DEPENDS
  // ON A BASE COLLECTION EXISTING (by ANY class A/B/C — index-local route,
  // sidebar wait, OR a per-base-collection read of the rendered config) is
  // EITHER guarded (registry guard OR a direct inline hasAdminCollection /
  // keepsBaseCollection self-skip) OR explicitly allowlisted in NON_GUARDED.
  // A NEW unguarded base-collection-dependent spec — including a rendered-config
  // reader, the class the original detector missed — fails here.
  test("every base-collection-dependent consumer spec is guarded or allowlisted", () => {
    const registered = new Set(reg.GUARDED_SPEC_NAMES);
    const allow = new Set(Object.keys(NON_GUARDED));
    const offenders = [];
    for (const { name, classes, src } of flaggedConsumerSpecs()) {
      if (registered.has(name)) continue; // group-2 registry guard
      if (allow.has(name)) continue; // documented exception
      if (appliesBaseCollectionGuard(src)) continue; // direct inline self-skip
      offenders.push({ name, classes });
    }
    expect(
      offenders.map((o) => `${o.name} [${o.classes.join(", ")}]`),
      `these consumer-running specs DEPEND on a base collection existing but apply ` +
        `NO recognized base_collections guard (neither a registry guard() nor a direct ` +
        `inline cap.hasAdminCollection / cap.keepsBaseCollection self-skip) and are NOT ` +
        `in the NON_GUARDED allowlist — a base_collections:[] consumer would red-fail ` +
        `them. Guard each (register it + its inline guard, OR add a direct inline ` +
        `cap.hasAdminCollection self-skip mirroring cms-config.spec.js), or allowlist ` +
        `it with a reason.`,
    ).toEqual([]);
  });

  // The detector must STAY comprehensive — it must keep flagging the
  // rendered-config-per-collection class (CLASS C) that the original
  // index-local-only detector MISSED. Anchor on the two specs that exposed the
  // blind spot: if the detector ever regresses so it no longer flags them, this
  // goes RED (and they'd silently lose drift protection).
  test("detector flags the rendered-config-per-collection class (the closed blind spot)", () => {
    for (const f of ["cms-preview-url.spec.js", "cms-form-clarity.spec.js"]) {
      const src = fs.readFileSync(path.join(HARNESS, f), "utf8");
      expect(
        baseCollectionClasses(src),
        `${f} reads the rendered admin config per base collection — the detector MUST ` +
          `flag it (rendered-config-per-collection) so the drift gate covers this class`,
      ).toContain("rendered-config-per-collection");
    }
  });

  // The detector must STAY comprehensive for the CLASS D single-page-SURFACE
  // group (#21) too — each anchor spec must keep getting flagged by its class,
  // so a future unguarded reviews-dashboard / preview-variant / canary-readonly
  // / posts-draft spec can't silently ship. If the detector regresses, this RED.
  test("detector flags the CLASS D single-page-surface specs (#21)", () => {
    const D = {
      "admin-reviews-health.spec.js": "reviews-dashboard",
      "admin-reviews-stats.spec.js": "reviews-dashboard",
      "preview-shell.spec.js": "preview-collection-variants",
      "cms-publish-loop.spec.js": "canary-readonly",
      "cms-publish-loop-preview.spec.js": "canary-readonly",
      "cms-preview-pr-self-contained.spec.js": "canary-readonly",
      "draft-isolation.spec.js": "posts-draft-write",
    };
    for (const [f, klass] of Object.entries(D)) {
      const src = fs.readFileSync(path.join(HARNESS, f), "utf8");
      expect(
        baseCollectionClasses(src),
        `${f} drives a single-page-incompatible surface — the detector MUST flag it ` +
          `(${klass}) so the #21 drift gate covers this class`,
      ).toContain(klass);
    }
  });

  // The CLASS D detector must be PRECISE — these specs touch the same surfaces
  // but are site-AGNOSTIC (single-page-compatible), so they must NOT be flagged.
  // A false flag would force a needless skip that masks a real regression on a
  // single-page consumer:
  //   - glow-banding         — samples the THEME background gradient on "/".
  //   - admin-reviews-auth   — navigates /admin/reviews/ but only drives the
  //                            OAuth handshake (#auth-screen), no review DATA.
  //   - preview-bridge       — only regex-matches the URL its builder helper
  //                            returns; never navigates to / renders a variant.
  test("detector does NOT flag the single-page-COMPATIBLE specs (precision boundary)", () => {
    for (const f of [
      "glow-banding.spec.js",
      "admin-reviews-auth.spec.js",
      "preview-bridge.spec.js",
    ]) {
      const src = fs.readFileSync(path.join(HARNESS, f), "utf8");
      expect(
        baseCollectionClasses(src),
        `${f} is single-page-COMPATIBLE — the detector must NOT flag it (guarding it ` +
          `would skip a real test on a single-page consumer)`,
      ).toEqual([]);
    }
  });

  // The allowlist must not rot: every NON_GUARDED entry must still EXIST, still
  // be consumer-running, still be FLAGGED by the detector (else it's not an
  // exception to anything), and still be UNGUARDED (else it belongs to the
  // guarded set, not the allowlist).
  test("NON_GUARDED allowlist has no stale entries", () => {
    const meta = platformMetaSpecs();
    for (const f of Object.keys(NON_GUARDED)) {
      const p = path.join(HARNESS, f);
      expect(fs.existsSync(p), `NON_GUARDED lists missing spec ${f}`).toBe(true);
      expect(
        meta.has(f),
        `${f} is a PLATFORM_META_SPEC — not consumer-running; drop it from NON_GUARDED`,
      ).toBe(false);
      const src = fs.readFileSync(p, "utf8");
      expect(
        baseCollectionClasses(src).length > 0,
        `${f} is in NON_GUARDED but the detector does NOT flag it as base-collection-` +
          `dependent — it's not an exception to anything; drop it`,
      ).toBe(true);
      expect(
        appliesBaseCollectionGuard(src),
        `${f} is in NON_GUARDED but it DOES apply a base_collections guard — remove the ` +
          `allowlist entry (it's already covered) or the guard`,
      ).toBe(false);
    }
  });

  // Registry and allowlist are disjoint (a spec can't be both guarded and
  // declared not-needing-a-guard).
  test("registry and NON_GUARDED allowlist are disjoint", () => {
    const both = reg.GUARDED_SPEC_NAMES.filter((n) => Object.keys(NON_GUARDED).includes(n));
    expect(both, "specs listed in BOTH the registry and NON_GUARDED").toEqual([]);
  });
});
