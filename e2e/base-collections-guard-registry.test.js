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
//       playwright.config.js PLATFORM_META_SPECS) that drives
//       /admin/index-local.html and navigates a base collection (route hash OR
//       sidebar-link wait) is EITHER registered OR in the explicit NON_GUARDED
//       allowlist (with a documented reason). A NEW unguarded generic-collection
//       spec turns this RED — the guard set cannot silently drift.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const reg = require("./base-collections-guards");
const cap = require("./site-capabilities");

const HARNESS = __dirname;
const FULL = path.join(HARNESS, "fixture-site");
const SINGLEPAGE = path.join(HARNESS, "fixture-site-singlepage");
const BASE = ["posts", "tags", "projects", "pages"];

// Consumer-running specs that drive index-local.html and navigate a base
// collection but DON'T need a base_collections guard, each with WHY. The
// drift lint allows exactly these; anything else must be registered.
const NON_GUARDED = {
  // Crawls _site/sitemap.xml URLs (incl. the admin dev shells) only to audit
  // <img> alt — it never navigates a collection route nor waits for a base
  // sidebar link; on a single-page consumer it just audits fewer pages.
  "image-alt-text.spec.js": "sitemap <img> audit — no collection navigation; degrades gracefully",
  // Pure-fs assertions on the THREE rendered admin shells' bytes; it lists
  // index-local.html as a candidate file path but does no page.goto.
  "cms-permalink-contract.spec.js": "pure-fs shell-bytes lint — no collection navigation",
};

// Re-read the canonical PLATFORM_META_SPECS list from playwright.config.js (the
// single source of truth for "not consumer-running"), so this lint and the
// runner agree without a second copy.
function platformMetaSpecs() {
  const cfg = fs.readFileSync(path.join(HARNESS, "playwright.config.js"), "utf8");
  const m = cfg.match(/PLATFORM_META_SPECS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("could not locate PLATFORM_META_SPECS in playwright.config.js");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

// Does a spec SOURCE drive /admin/index-local.html and navigate a base
// collection — via the route hash (index-local.html#/collections/<base>) OR by
// waiting/clicking a base sidebar link in a file whose admin shell is
// index-local (no index-test.html page.goto)? This is the drift signal: the
// shape that breaks on a base_collections:[] consumer.
function drivesIndexLocalBaseCollection(src) {
  const routeHash = BASE.some((c) =>
    new RegExp(`index-local\\.html#/collections/${c}\\b`).test(src),
  );
  if (routeHash) return true;
  // Sidebar-link signal — only count it when the file actually loads
  // index-local AND never loads index-test (index-test → config-test.yml is
  // FIXED, not opted-out, so those specs must NOT be guarded).
  const loadsIndexLocal = /page\.goto\(\s*["']\/admin\/index-local\.html/.test(src);
  const loadsIndexTest = /page\.goto\(\s*["']\/admin\/index-test\.html/.test(src);
  if (loadsIndexLocal && !loadsIndexTest) {
    const sidebarWait = BASE.some((c) =>
      new RegExp(`getByRole\\(\\s*["']link["']\\s*,\\s*\\{\\s*name:\\s*/\\^${c}\\$/i`).test(src),
    );
    if (sidebarWait) return true;
  }
  return false;
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

test.describe("#33 base_collections guard registry — no silent drift", () => {
  // (3) Every consumer-running index-local generic-collection spec is registered
  // or explicitly allowlisted. A new unguarded one fails here.
  test("every index-local generic-collection consumer spec is registered or allowlisted", () => {
    const meta = platformMetaSpecs();
    const registered = new Set(reg.GUARDED_SPEC_NAMES);
    const allow = new Set(Object.keys(NON_GUARDED));
    const offenders = [];
    for (const f of fs.readdirSync(HARNESS)) {
      if (!f.endsWith(".spec.js")) continue;
      if (meta.has(f)) continue; // not consumer-running
      const src = fs.readFileSync(path.join(HARNESS, f), "utf8");
      if (!drivesIndexLocalBaseCollection(src)) continue;
      if (registered.has(f) || allow.has(f)) continue;
      offenders.push(f);
    }
    expect(
      offenders,
      `these consumer-running specs drive /admin/index-local.html + navigate a base ` +
        `collection but are NEITHER registered in base-collections-guards.js NOR in ` +
        `the NON_GUARDED allowlist — a base_collections:[] consumer would red-fail them. ` +
        `Register each (with its inline guard) or allowlist it with a reason:\n` +
        offenders.map((o) => `  • ${o}`).join("\n"),
    ).toEqual([]);
  });

  // The allowlist must not rot: every NON_GUARDED entry must still exist and
  // still be a consumer-running index-local spec (else delete the entry).
  test("NON_GUARDED allowlist has no stale entries", () => {
    const meta = platformMetaSpecs();
    for (const f of Object.keys(NON_GUARDED)) {
      const p = path.join(HARNESS, f);
      expect(fs.existsSync(p), `NON_GUARDED lists missing spec ${f}`).toBe(true);
      expect(meta.has(f), `${f} is a PLATFORM_META_SPEC — not consumer-running; drop it from NON_GUARDED`).toBe(false);
    }
  });

  // Registry and allowlist are disjoint (a spec can't be both guarded and
  // declared not-needing-a-guard).
  test("registry and NON_GUARDED allowlist are disjoint", () => {
    const both = reg.GUARDED_SPEC_NAMES.filter((n) => Object.keys(NON_GUARDED).includes(n));
    expect(both, "specs listed in BOTH the registry and NON_GUARDED").toEqual([]);
  });
});
