// @lane: local — pure-fs static invariants on the publishing-UX staged plan (phases 2-5).
//
// docs/PUBLISHING-UX.md §4 stages the fix for a product in which an editor
// meets NINE overlapping notions of "published" across four systems. Phase 1
// shipped the state bar; phases 2-5 are:
//
//   2  one door        — hide the Status dropdown and the Workflow board on
//                        the PRODUCTION shell, so Publish is the only route
//                        to production (one-door-publish.js);
//   3  one button      — replace Decap's split Publish control with a
//                        platform-owned button (publish-button.js);
//   4  a real progress state — poll the entry's own PR so the invisible
//                        5-15 minutes stops being a silence
//                        (publish-progress.js), and suppress Decap's false
//                        "Failed to publish" toast;
//   5  one vocabulary  — four badges + two modifiers, derived once
//                        (entry-status-model.js) and rendered by both the
//                        editor bar and the collection list, plus the
//                        site-level gate banner (site-gate-banner.js).
//
// This is the cheap pure-fs half — no browser, no build, no network. The
// behavioural half is e2e/admin-one-door.spec.js and the model's own unit
// tests in e2e/entry-status-model.test.js (which are the ones that can
// actually exercise the logic, and were proved able to fail by inverting the
// model's precedence).
//
// Registered in PLATFORM_META_SPECS: it reads the platform's theme/admin
// SOURCE tree and BOTH render paths (scripts/render-decap-config.rb and the
// gem hook), none of which a consumer has in that position — the same
// reasoning that registers admin-shim-load-order.test.js and
// admin-329-shims.test.js.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const {
  fixedPositionEvidence,
  hasCssDisplayNoneHide,
  removeChildReceivers,
  stringLiterals,
  readsMember,
  hasBareReturnGuardOn,
} = require("./admin-shim-rules");

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "theme", "admin");

const MODEL = "entry-status-model.js";
const POLLER = "publish-progress.js";
const BUTTON = "publish-button.js";
const ONE_DOOR = "one-door-publish.js";
const GATE_BANNER = "site-gate-banner.js";

// The shells that carry a real GitHub backend and a real deploy. Everything
// that talks to the GitHub API or hides a Decap control is scoped here.
const PRODUCTION_ONLY = [POLLER, BUTTON, ONE_DOOR, GATE_BANNER];
// The pure model is loaded everywhere, because posts-list-enhance.js runs on
// all three shells and renders the same badges from it.
const ALL_SHELLS_FILES = [MODEL];
const NEW_FILES = [MODEL, POLLER, BUTTON, ONE_DOOR, GATE_BANNER];

function admin(name) {
  return fs.readFileSync(path.join(ADMIN_DIR, name), "utf8");
}

// Mirrors admin-329-shims.test.js / admin-shim-load-order.test.js.
function scriptTag(html, basename) {
  const re = new RegExp(
    `<script\\s+src="${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([^>]*)>\\s*</script>`,
  );
  const m = re.exec(html);
  if (!m) return null;
  return { index: m.index, defer: /\bdefer\b/.test(m[1]) };
}

test.describe("publishing UX phases 2-5 — files and wiring", () => {
  test("every new shim exists under theme/admin/", () => {
    const missing = NEW_FILES.filter((n) => !fs.existsSync(path.join(ADMIN_DIR, n)));
    expect(missing, `missing shim file(s) under theme/admin/: ${missing.join(", ")}`).toEqual([]);
  });

  test("index.html loads all five, deferred", () => {
    const html = admin("index.html");
    for (const name of NEW_FILES) {
      const tag = scriptTag(html, name);
      expect(tag, `index.html must load <script src="${name}">`).not.toBeNull();
      expect(tag.defer, `index.html: ${name} must be deferred`).toBe(true);
    }
  });

  // ORDER IS LOAD-BEARING, and `defer` executes in document order. Each of
  // these three is a real dependency, not a tidiness preference:
  //   - the model is what the poller's consumers derive words from;
  //   - publish-button.js reads the poller's PR number, so a button that
  //     loaded first would render its "nothing to publish" branch and hide
  //     Decap's control with no working replacement behind it;
  //   - the button renders INTO the slot publish-step-hint.js creates.
  test("index.html loads them in dependency order", () => {
    const html = admin("index.html");
    const at = (n) => scriptTag(html, n).index;
    expect(at(MODEL), `${MODEL} must load before ${POLLER}`).toBeLessThan(at(POLLER));
    expect(at(MODEL), `${MODEL} must load before publish-step-hint.js`).toBeLessThan(
      at("publish-step-hint.js"),
    );
    expect(at(MODEL), `${MODEL} must load before posts-list-enhance.js`).toBeLessThan(
      at("posts-list-enhance.js"),
    );
    expect(at(POLLER), `${POLLER} must load before ${BUTTON}`).toBeLessThan(at(BUTTON));
    expect(
      at("publish-step-hint.js"),
      `publish-step-hint.js must load before ${BUTTON} — the button renders into the slot the bar creates`,
    ).toBeLessThan(at(BUTTON));
  });

  // The scope IS the contract, so assert the negative directly rather than
  // trusting nobody copies a tag across (the local-save-indicator.js
  // precedent in admin-329-shims.test.js).
  //
  //   index-test.html  is the REHEARSAL surface: cms-editorial-workflow.spec.js
  //                    and cms-workflow-states.spec.js drive Decap's REAL
  //                    Status control and board there, and hiding them would
  //                    delete the coverage that tells us Decap still behaves
  //                    the way one-door-publish.js assumes.
  //   index-local.html has no editorial workflow at all (config-local.base.yml
  //                    sets no publish_mode), so there is no PR to poll, no
  //                    Status control to hide and no board to close.
  test("the other two shells load ONLY the pure model, never the GitHub-talking shims", () => {
    for (const shell of ["index-local.html", "index-test.html"]) {
      const html = admin(shell);
      for (const name of ALL_SHELLS_FILES) {
        expect(scriptTag(html, name), `${shell} must load ${name}`).not.toBeNull();
      }
      for (const name of PRODUCTION_ONLY) {
        expect(
          scriptTag(html, name),
          `${shell} must NOT load ${name} — it is scoped to the production shell ` +
            "(see this spec's scope note; index-test.html must keep exercising Decap's " +
            "own Status control and board, and index-local.html has no editorial workflow)",
        ).toBeNull();
      }
    }
  });
});

test.describe("publishing UX phases 2-5 — house rules for an admin shim", () => {
  // No admin shim may paint a fixed overlay over the editor toolbar. This is
  // the measured rule from §2.3: publish-step-hint.js's first version was a
  // fixed top-centre notice and it covered 68% of the Publish button and 47%
  // of the Status control at 1280x800 on Decap 3.15.1 — while staying
  // invisible to the hit-test occlusion guard, because `pointer-events: none`
  // makes an overlay transparent to elementFromPoint.
  //
  // site-gate-banner.js is the one most at risk of it: it is PERMANENT chrome,
  // and the obvious implementation is a fixed bar pinned to the top, which is
  // exactly where Decap's own toolbar lives.
  for (const name of NEW_FILES) {
    test(`${name} renders in flow — no position:fixed`, () => {
      expect(
        fixedPositionEvidence(admin(name)),
        `${name} must not paint a position:fixed overlay — every one of these renders ` +
          "over the editor toolbar's own fixed position. See docs/PUBLISHING-UX.md §2.3.",
      ).toEqual([]);
    });
  }

  // Public API on both sides is this directory's house style: the GitHub REST
  // API and the DOM, never window.CMS internals and never Decap's Redux store.
  // A store reference survives a Decap upgrade silently — it does not throw,
  // it just reads undefined — which is the worst failure mode available.
  for (const name of NEW_FILES) {
    test(`${name} touches no Decap internal store`, () => {
      expect(
        /\b(getState|dispatch)\b/i.test(admin(name)),
        `${name} must use only public DOM + REST — no Decap Redux internals`,
      ).toBe(false);
    });
  }

  // CSS-hide, never removeChild. Decap is React-driven and re-mounts elements
  // it owns when it finds them missing, which the observer then re-removes —
  // a fight loop that wedged the editor mid-flow on the failed prod-mutate and
  // host-loop runs at commit 503365a. `display:none` leaves the node where
  // React expects it, and React does not observe inline styles.
  for (const name of [ONE_DOOR, BUTTON]) {
    test(`${name} hides Decap's control with CSS, never by removing it`, () => {
      const src = admin(name);
      expect(
        hasCssDisplayNoneHide(src),
        `${name} must hide via el.style.setProperty("display","none",…) — the ` +
          "native-preview-href.js idiom",
      ).toBe(true);
      // Removing a node the shim ITSELF created is fine; removing one React
      // owns is the fight loop. So the lint asks which object is emptied.
      const receivers = removeChildReceivers(src);
      const foreign = receivers.filter((r) => r !== "slot");
      expect(
        foreign,
        `${name} may only removeChild from its OWN container (\`slot\`), never from a ` +
          "Decap-owned node — React re-mounts what it owns and the observer re-removes it, " +
          "which is the fight loop that wedged the editor at commit 503365a",
      ).toEqual([]);
    });
  }
});

test.describe("publishing UX phase 4 — the false-failure toast suppressor", () => {
  // publish-via-auto-merge.js hands Decap a DELIBERATE 422 (a 2xx would make
  // Decap delete the head ref and close the still-open PR — #80 layer 9), and
  // Decap's catch then flashes "Failed to publish" over a publish that is in
  // fact under way. The suppressor removes ONLY that toast, and it identifies
  // it by the marker string this same file put in the 422 body.
  //
  // So the two literals must stay in lockstep. If someone edits the 422 copy
  // and not the matcher, the suppressor silently stops matching and the false
  // error comes back — with every pure-fs lint green, because each literal is
  // individually fine. THIS is the assertion that sees it.
  test("the suppressor's marker is a substring of the 422 body it must match", () => {
    const src = admin("publish-via-auto-merge.js");
    const literals = stringLiterals(src);
    const marker = "Queued for auto-merge via the cms/ready label";
    expect(
      literals.includes(marker),
      "publish-via-auto-merge.js must declare the SUPPRESS_MARKER literal verbatim",
    ).toBe(true);
    const carriers = literals.filter((l) => l !== marker && l.includes(marker));
    expect(
      carriers.length,
      "the synthetic 422's message must still CONTAIN the suppressor's marker — " +
        "otherwise the suppressor matches nothing and Decap's false " +
        '"Failed to publish" error returns',
    ).toBeGreaterThan(0);
  });

  // The other half of the same contract: the matcher must ALSO require
  // Decap's failure wording, so it can never eat a REAL publish failure.
  // Replacing a misleading error with a silent one would be worse than the
  // defect it fixes.
  test("the suppressor also requires Decap's own failure wording", () => {
    expect(
      /failed to publish/i.test(admin("publish-via-auto-merge.js")),
      "the suppressor must match on Decap's failure wording AND the marker, never the " +
        "marker alone — a real failure must still be shown",
    ).toBe(true);
  });
});

test.describe("publishing UX phase 4 — the poller's budget", () => {
  // An admin left open in a background tab must not spend the editor's GitHub
  // rate limit polling an entry nobody is looking at. The guard is a real
  // read of document.hidden, not a comment promising one.
  test("publish-progress.js skips a tick while the tab is hidden", () => {
    expect(
      readsMember(admin(POLLER), "document", "hidden"),
      "publish-progress.js must read document.hidden and skip the tick — see its " +
        "Budget header",
    ).toBe(true);
  });
});

test.describe("publishing UX phase 5 — the site gate", () => {
  // The platform must never hardcode one site's identity, and "which boolean
  // gates this site" is identity. A site with no gate — adamdaniel.ai, every
  // scaffolded site — must get a completely inert shim, not a banner about a
  // setting it does not have.
  test("site-gate-banner.js is inert unless the site declares a gate", () => {
    const src = admin(GATE_BANNER);
    expect(
      src.includes("window.CMS_SITE_GATE"),
      "site-gate-banner.js must read the injected window.CMS_SITE_GATE",
    ).toBe(true);
    expect(
      hasBareReturnGuardOn(src, "gate"),
      "site-gate-banner.js must return early when no gate is declared — a site " +
        "without one must load an inert shim, never a banner about a setting it has not got",
    ).toBe(true);
  });

  // Both render paths must inject the global. decap-config-render-parity.test.js
  // asserts the two paths inject the SAME keys, which is necessary and not
  // sufficient: dropping the key from BOTH stays parity-green and silently
  // turns the banner off everywhere.
  test("both render paths inject window.CMS_SITE_GATE", () => {
    const paths = [
      path.join(REPO_ROOT, "scripts", "render-decap-config.rb"),
      path.join(REPO_ROOT, "theme", "lib", "cms-platform-theme", "decap_config_hook.rb"),
    ];
    for (const p of paths) {
      expect(
        fs.readFileSync(p, "utf8").includes("window.CMS_SITE_GATE="),
        `${path.relative(REPO_ROOT, p)} must inject window.CMS_SITE_GATE — parity alone ` +
          "cannot catch both paths dropping it together",
      ).toBe(true);
    }
  });

  // Ruby's Hash#inspect emits `{"a"=>1}`, which is a SYNTAX ERROR in
  // JavaScript — and it would land inside the shell's <script> block, taking
  // the whole admin down rather than degrading. Every other injected global is
  // a string, where .inspect happens to be valid JS, so this is the one key
  // where the file's own established idiom is wrong.
  test("the gate is serialised as JSON, never with Ruby's inspect", () => {
    for (const p of [
      path.join(REPO_ROOT, "scripts", "render-decap-config.rb"),
      path.join(REPO_ROOT, "theme", "lib", "cms-platform-theme", "decap_config_hook.rb"),
    ]) {
      const src = fs.readFileSync(p, "utf8");
      expect(
        /gate_js\s*=\s*gate\.nil\?\s*\?\s*['"]null['"]\s*:\s*JSON\.generate\(gate\)/.test(src),
        `${path.relative(REPO_ROOT, p)} must build the gate global with JSON.generate — ` +
          "Ruby's Hash#inspect emits `{\"a\"=>1}`, a JS syntax error that would break " +
          "the whole admin shell rather than degrade",
      ).toBe(true);
    }
  });
});

test.describe("publishing UX phase 5 — one vocabulary, two surfaces", () => {
  // The §2.9 defect this whole phase exists to end: three vocabularies for
  // three states. Both surfaces must read their words from the shared model
  // rather than spelling them out, or they drift apart again the first time
  // one of them is edited alone.
  for (const [file, why] of [
    ["publish-step-hint.js", "the editor bar"],
    ["posts-list-enhance.js", "the collection list"],
  ]) {
    test(`${file} derives its words from the shared model`, () => {
      expect(
        admin(file).includes("CMSEntryStatus"),
        `${file} (${why}) must render window.CMSEntryStatus's derivation, not its own ` +
          "hand-written status words — see docs/PUBLISHING-UX.md §2.9",
      ).toBe(true);
    });
  }

  // The old pill read Published / Draft / Scheduled, which mixed the
  // "is it on the website" axis with the front-matter axis under one word
  // (§2.6). The badge is now the former and the modifiers are the latter.
  test("the collection list no longer hardcodes the retired pill vocabulary", () => {
    const src = admin("posts-list-enhance.js");
    expect(
      /label:\s*"Published"/.test(src) === false || src.includes("SHORT_LABELS"),
      "posts-list-enhance.js must render the shared SHORT_LABELS, not a local " +
        "Published/Draft/Scheduled table",
    ).toBe(true);
    expect(
      src.includes("MODIFIER_LABELS"),
      "posts-list-enhance.js must take the modifier words from the shared model too",
    ).toBe(true);
  });
});
