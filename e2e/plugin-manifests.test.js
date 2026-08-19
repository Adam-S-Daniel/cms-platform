// @lane: local — pure-fs lint (no browser, no build, no network) over this
// repo's TWO plugin manifests and the skills they publish.
//
// WHY THIS LINT LIVES HERE AND NOT IN `agentskills`. `skills/` ships as a
// FEDERATED bundle in the `agentskills` marketplace: the marketplace ENTRY
// lives in that repo, but its source is
// `{"source":"github","repo":"Adam-S-Daniel/cms-platform"}` with NO
// subdirectory path — so THIS repo's root is the plugin root, and the
// manifests plus every `skills/<name>/SKILL.md` are files only this repo can
// see. `agentskills` validates its own bundles' manifests in its own CI and
// structurally cannot reach these. If this repo doesn't lint them, nothing
// does: both repos stay green while the pair drifts.
//
// THE TWO-MANIFEST MODEL (mirrors the fleet shape in `agentskills`)
//   .claude-plugin/plugin.json   Claude Code
//   plugin.json  (repo root)     Agent Plugins 1.0.0 — Codex >= 0.147.0,
//                                VS Code, Cursor, Copilot
// Claude Code is not an Agent Plugins conformant client and reads only the
// first; the conformant clients read only the second. They coexist rather than
// one replacing the other, which is exactly what makes `name` and `version` —
// carried twice, by hand — a standing drift hazard: bump one, forget the
// other, and the client reading the stale copy reports the wrong plugin
// forever. Hence the cross-check below, which is the same contract
// `agentskills`' scripts/check_agent_plugins.py enforces for its own bundles.
//
// WHY `version` IS PRESENT AT ALL, AND WHAT KEEPS IT HONEST. A manifest with
// no `version` is the single warning that makes `claude plugin validate
// --strict` FAIL. The value tracks AGENTS.md's "Current release:" — and it
// shipped WRONG the first time (both manifests declared 0.1.82 inside the
// v0.1.83 change that introduced them, and nothing existed to correct it). Two
// locks now, deliberately at different ends: this file locks the two copies to
// EACH OTHER, and `.github/workflows/release.yml` refuses to cut a tag whose
// version the manifests disagree with, which locks them to the TAG. The release
// job cannot rewrite-and-push them instead — `main` is PR-only by ruleset — so
// the bump belongs in the release PR, reviewed alongside AGENTS.md and
// docs/VERSION-HISTORY.md.
//
// WHAT THE SKILL ITEMS ARE FOR. A frontmatter `name` that disagrees with its
// directory basename, and a `description` past the 1024-character Agent Skills
// cap, are the two defects that reached a consumer PAST a green CI. Neither is
// visible from the manifests, so they are locked here alongside them.
//
// WHY THIS FILE ALSO SCHEMA-VALIDATES THE ROOT MANIFEST. `agentskills`'
// scripts/check_agent_plugins.py prints, for this bundle: "federated from
// Adam-S-Daniel/cms-platform — its Agent Plugins manifests are validated by
// that repo's own CI, not here." That sentence is a PROMISE, and this file is
// the only place that can keep it: that script validates the manifests it can
// DISCOVER (directories under its own plugins/), and a federated entry has no
// such directory. `claude plugin validate` does not close the gap either — it
// never reads the root plugin.json at all (measured 2026-08-14: a root manifest
// carrying a 2.0.0 `$schema` plus `category`/`defaultEnabled`/`skills`/
// `author.github` still exits 0). So the schema contract is asserted below.
//
// AND WHY THE self-ci LANE THAT RUNS `claude plugin validate` IS NON-STRICT.
// It is not an oversight and must not be "fixed" by deleting CLAUDE.md:
// `--strict` promotes warnings to errors, and this plugin root permanently
// emits one — "CLAUDE.md at the plugin root is not loaded as project context"
// — for a file the _agent-guidance sync owns and this repo must keep. The CLI
// is gated anyway because it is the only check that parses each
// skills/*/SKILL.md the way the runtime does (unparseable frontmatter YAML =>
// exit 1), which is the exact defect that shipped in consumer-repo-provisioning.
//
// PARSE, NEVER REGEX. The frontmatter goes through the `yaml` library (already
// an e2e devDependency). `skills/consumer-repo-provisioning/SKILL.md` writes its
// description as a `>-` folded block scalar — a regex would hand back the
// literal ">-" and then measure the wrong string against the cap, i.e. a check
// that passes while checking nothing.
//
// SKIP DISCIPLINE. PLATFORM-ONLY: the whole file skips when SITE_ROOT is set.
// On a CONSUMER lane the harness is copied to the SITE root (see
// e2e-tests.yml's local lane), so `path.resolve(__dirname, "..")` resolves to
// the consuming site, which ships none of this. The skip keys off that ONE
// named condition and never off "the file wasn't there" — a missing manifest
// is the failure this lint exists to catch, so it must never be a reason to
// go quiet.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

// The repo root IS the plugin root: `.claude-plugin/plugin.json` sits beside
// `skills/`, which is what lets the marketplace entry name no subdirectory.
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const CLAUDE_MANIFEST = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
const ROOT_MANIFEST = path.join(PLUGIN_ROOT, "plugin.json");
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

// The marketplace entry's name. Skills namespace by bundle, so this is also the
// `/cms-platform:<skill>` prefix an editor types (see skills/README.md) —
// changing it orphans every existing invocation, so it is pinned, not derived.
const BUNDLE_NAME = "cms-platform";

// The GitHub repo the marketplace `source` resolves the bundle from.
const BUNDLE_REPO = "Adam-S-Daniel/cms-platform";

// Agent Skills caps a skill's frontmatter `description` at 1024 characters.
const DESCRIPTION_MAX = 1024;

// ── The Agent Plugins 1.0.0 manifest schema, VENDORED ───────────────────
//   file        e2e/fixtures/agent-plugins-1.0.0-plugin.schema.json
//   source      https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
//   mirror      https://raw.githubusercontent.com/agentplugins/
//               agent-plugins-spec/main/schemas/1.0.0/plugin.schema.json
//   size        1805 bytes
//   sha256      0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883
//   retrieved   2026-08-14, byte-for-byte from agentskills'
//               schemas/agent-plugins-1.0.0-plugin.schema.json (same digest),
//               which is where the provenance above was established.
//
// VENDORED, not fetched: the spec repo publishes no tags and no releases, so a
// fetch has nothing to pin to and would silently track whatever `main` says
// today — and a pure-fs lint must not acquire a network dependency. JSON has no
// comment syntax, so the provenance lives here and SCHEMA_SHA256 turns it into
// an assertion: tamper with the vendored bytes and the run FAILS rather than
// validating against something nobody reviewed. Same posture as agentskills'
// checker, deliberately — a swapped schema is the one way this whole check
// could be made to pass while asserting nothing.
const SCHEMA_FILE = path.join(__dirname, "fixtures", "agent-plugins-1.0.0-plugin.schema.json");
const SCHEMA_SHA256 = "0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883";

// Read the vendored schema, refusing to hand back anything but the reviewed
// bytes. Callers get a parsed schema or a failed expectation — never a
// silently-substituted document.
function loadSchema() {
  expect(
    fs.existsSync(SCHEMA_FILE),
    `${rel(SCHEMA_FILE)} must exist — it is the contract the root manifest is validated against.`,
  ).toBe(true);
  const raw = fs.readFileSync(SCHEMA_FILE);
  expect(
    crypto.createHash("sha256").update(raw).digest("hex"),
    `${rel(SCHEMA_FILE)}: sha256 mismatch. The vendored schema was modified; re-fetch it from ` +
      `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and update SCHEMA_SHA256 only ` +
      `after reviewing the diff.`,
  ).toBe(SCHEMA_SHA256);
  return JSON.parse(raw.toString("utf8"));
}

// "a"/"an" for a schema type name, so a derived message still reads as English
// ("must be an array", not "must be a array") without the type ever being typed
// out here.
function article(type) {
  return /^[aeiou]/.test(type) ? "an" : "a";
}

// JSON-Schema's type name for a runtime value (arrays are not "object" here).
function jsonTypeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value === "object" ? "object" : typeof value;
}

// Validate `doc` against the vendored schema and return EVERY problem found
// (empty ⇒ conformant). No JSON-Schema library: the harness's dependency set is
// pinned and a validator is a big new supply-chain surface for a five-rule
// closed schema. What matters is that nothing here is RETYPED — the pinned
// `$schema` URI, the required list, the allowed top-level keys, the allowed
// `author` keys and every declared type are READ OUT OF the schema document, so
// a re-fetched schema that gains/loses a key moves this check with it. A
// hand-copied key list that drifts from the schema is precisely the bug this
// repo's conventions forbid.
//
// Only the ROOT manifest is validated: `.claude-plugin/plugin.json` is Claude
// Code's own format, not an Agent Plugins document, and holding it to this
// schema would be asserting the wrong contract.
function agentPluginsProblems(doc, schema) {
  const problems = [];
  const props = (schema && schema.properties) || {};

  // Deriving "allowed keys" from `properties` is only sound while the schema is
  // CLOSED. If a future re-fetch opens it, say so instead of silently turning
  // the unknown-key checks below into a rule the spec no longer makes.
  if (schema.additionalProperties !== false) {
    problems.push(
      "vendored schema is no longer closed (additionalProperties !== false) — the allowed-key " +
        "derivation below is unsound against it; re-review the schema before trusting this check",
    );
    return problems;
  }

  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) {
      problems.push(`missing required key '${key}'`);
    }
  }

  // `$schema` is pinned by `const`, and Codex rejects anything else outright
  // ("unsupported Agent Plugins schema") — a typo is a hard failure, not a soft
  // one. Checked only when present; an absent one is already reported above.
  const pinned = props.$schema && props.$schema.const;
  if (Object.prototype.hasOwnProperty.call(doc, "$schema") && doc.$schema !== pinned) {
    problems.push(
      `'$schema' must be exactly ${JSON.stringify(pinned)}, got ${JSON.stringify(doc.$schema)}`,
    );
  }

  for (const key of Object.keys(doc)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      problems.push(
        `unknown top-level key '${key}' — the schema is closed (additionalProperties: false); ` +
          `client-specific data belongs under 'extensions', keyed by reverse domain`,
      );
    }
  }

  // Declared types, read off the schema. Covers `keywords` (array of strings)
  // and every scalar-typed key without naming any of them here.
  for (const [key, value] of Object.entries(doc)) {
    const declared = props[key] && props[key].type;
    if (typeof declared !== "string") continue;
    const actual = jsonTypeOf(value);
    if (actual !== declared) {
      problems.push(`'${key}' must be ${article(declared)} ${declared}, got ${actual}`);
      continue;
    }
    const itemType = declared === "array" && props[key].items && props[key].items.type;
    if (typeof itemType === "string") {
      value.forEach((item, i) => {
        if (jsonTypeOf(item) !== itemType) {
          problems.push(
            `'${key}[${i}]' must be ${article(itemType)} ${itemType}, got ${jsonTypeOf(item)}`,
          );
        }
      });
    }
  }

  // `author` is a closed sub-object too (name/email/url only) — so the same
  // derivation, from the same document.
  const authorSchema = props.author || {};
  if (doc.author && jsonTypeOf(doc.author) === "object") {
    if (authorSchema.additionalProperties !== false) {
      problems.push(
        "vendored schema's 'author' is no longer closed — its allowed-key derivation is unsound",
      );
    } else {
      const allowed = Object.keys(authorSchema.properties || {});
      for (const key of Object.keys(doc.author)) {
        if (!allowed.includes(key)) {
          problems.push(
            `unknown 'author' key '${key}' — author is closed too ` +
              `(allowed: ${allowed.join(", ")})`,
          );
        }
      }
    }
  }

  return problems;
}

const CONSUMER = !!process.env.SITE_ROOT;
const SKIP_REASON =
  "SITE_ROOT is set (CONSUMER lane) — the harness is copied to the SITE root there, so " +
  "`path.resolve(__dirname, '..')` is the consuming site, which ships no plugin manifests " +
  "and no skills/. This lint asserts the PLATFORM repo's own plugin shape and runs in " +
  "self-ci.yml's node-unit-lints lane.";

function rel(file) {
  return path.relative(PLUGIN_ROOT, file);
}

function loadManifest(file, client) {
  const label = `${rel(file)} (the ${client} manifest)`;
  expect(
    fs.existsSync(file),
    `${label} must exist — without it this repo is not a plugin root and the federated ` +
      `marketplace entry cannot resolve the bundle.`,
  ).toBe(true);

  let doc;
  let parseError = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    parseError = err;
  }
  expect(
    parseError,
    `${label} must be valid JSON` + (parseError ? ` (got: ${parseError.message})` : ""),
  ).toBeNull();

  return { label, doc };
}

// Every `skills/<name>/` directory. Derived from the filesystem, never a
// hardcoded list, so a newly-added skill is covered the moment it lands (and a
// half-built one is reported as broken rather than skipped into silence).
// `skills/README.md` is a FILE at that level and is correctly excluded.
function skillDirs() {
  // No existsSync guard on purpose: an absent skills/ must throw ENOENT here
  // and FAIL the run. Wrapping it in a "skip if missing" is the one change that
  // would turn this whole file green on a bundle that publishes no skills.
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  // A floor, not decoration: with zero skills every per-skill assertion below
  // passes vacuously, which is the exact "green check that checks nothing"
  // shape this file exists to remove.
  expect(
    dirs.length,
    `${rel(SKILLS_DIR)} must hold at least one skill directory — an empty bundle would make ` +
      `every per-skill assertion in this file pass vacuously.`,
  ).toBeGreaterThan(0);
  return dirs;
}

// Split the leading `---`-fenced block off a SKILL.md and hand the BODY to a
// real YAML parser. Which line is a fence is a lexical question, so a line scan
// answers it; everything between the fences is structure and goes to `yaml`.
function frontmatter(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    return { error: "must open with a `---` frontmatter fence on line 1" };
  }
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) {
    return { error: "has no closing `---` frontmatter fence" };
  }
  let doc;
  try {
    doc = YAML.parse(lines.slice(1, close).join("\n"));
  } catch (err) {
    return { error: `has frontmatter that is not valid YAML (${err.message})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { error: "has frontmatter that does not parse as a YAML mapping" };
  }
  return { doc };
}

// One parsed record per skill: { dir, label, error|null, doc|null }. Shared by
// the two per-skill tests so each reads the tree once and reports EVERY
// offender, not just the first. `label` is what an offender line leads with, so
// a skill directory that ships NO SKILL.md names the DIRECTORY rather than a
// file that isn't there.
function parsedSkills() {
  return skillDirs().map((dir) => {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fs.existsSync(file)) {
      return { dir, label: `${dir}/`, error: "ships no SKILL.md", doc: null };
    }
    const { doc, error } = frontmatter(file);
    return { dir, label: `${dir}/SKILL.md`, error: error || null, doc: doc || null };
  });
}

test.describe("plugin manifests: this repo is a publishable federated bundle", () => {
  test("both manifests exist and are valid JSON", () => {
    test.skip(CONSUMER, SKIP_REASON);

    loadManifest(CLAUDE_MANIFEST, "Claude Code");
    loadManifest(ROOT_MANIFEST, "Agent Plugins 1.0.0");
  });

  test(`both manifests name the bundle \`${BUNDLE_NAME}\` at the plugin root`, () => {
    test.skip(CONSUMER, SKIP_REASON);

    const claude = loadManifest(CLAUDE_MANIFEST, "Claude Code");
    const root = loadManifest(ROOT_MANIFEST, "Agent Plugins 1.0.0");

    for (const { label, doc } of [claude, root]) {
      expect(
        doc.name,
        `${label}: 'name' must be "${BUNDLE_NAME}" — it has to equal the marketplace entry's ` +
          `name in agentskills, which is also the /${BUNDLE_NAME}:<skill> prefix editors type.`,
      ).toBe(BUNDLE_NAME);
    }

    // The directory contract the federated entry depends on: because the entry
    // names NO subdirectory, the marketplace treats the repo root as the plugin
    // root — so `.claude-plugin/` and `skills/` must be SIBLINGS there. Move
    // either one down a level and the bundle resolves with zero skills while
    // every JSON assertion above still passes.
    //
    // Both facts are read off the DISK deliberately. The tempting shorthand —
    // asserting `path.dirname(path.dirname(CLAUDE_MANIFEST))` equals
    // PLUGIN_ROOT — is a tautology: that path is DERIVED from PLUGIN_ROOT by
    // path.join two lines up, so it can never disagree, and the assertion would
    // read as coverage while proving nothing. (Caught by running this file
    // against a deliberately nested-skills fixture: the tautology fired on a
    // path-normalization artifact and MASKED the two real checks below.)
    for (const dir of [path.dirname(CLAUDE_MANIFEST), SKILLS_DIR]) {
      expect(
        fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
        `${rel(dir)} must be a directory directly under the plugin root, alongside its ` +
          `sibling — the marketplace entry names no subdirectory path, so the manifest is ` +
          `read from <plugin-root>/.claude-plugin/ and skills are discovered by convention ` +
          `at <plugin-root>/skills/.`,
      ).toBe(true);
    }

    expect(
      String(root.doc.repository || ""),
      `${root.label}: 'repository' must name ${BUNDLE_REPO} — the marketplace source resolves ` +
        `the bundle from that repo, and a conformant client follows this field instead.`,
    ).toContain(BUNDLE_REPO);
  });

  test("the version is present in both manifests and the two agree", () => {
    test.skip(CONSUMER, SKIP_REASON);

    const claude = loadManifest(CLAUDE_MANIFEST, "Claude Code");
    const root = loadManifest(ROOT_MANIFEST, "Agent Plugins 1.0.0");

    for (const { label, doc } of [claude, root]) {
      expect(
        typeof doc.version === "string" && doc.version.length > 0,
        `${label}: 'version' must be a non-empty string — an absent version is the single ` +
          `warning that makes \`claude plugin validate --strict\` fail.`,
      ).toBe(true);
    }

    expect(
      root.doc.version,
      `'version' disagrees between the manifests — ${rel(ROOT_MANIFEST)} has ` +
        `"${root.doc.version}", ${rel(CLAUDE_MANIFEST)} has "${claude.doc.version}". Both ship; ` +
        `they describe ONE plugin, and whichever client reads the stale copy reports the wrong ` +
        `version forever. Bump them together.`,
    ).toBe(claude.doc.version);
  });

  test("the vendored schema is the reviewed one and the root manifest obeys it", () => {
    test.skip(CONSUMER, SKIP_REASON);

    const schema = loadSchema();
    const root = loadManifest(ROOT_MANIFEST, "Agent Plugins 1.0.0");

    expect(
      agentPluginsProblems(root.doc, schema),
      `${root.label} must satisfy Agent Plugins 1.0.0. This is the check agentskills' ` +
        `check_agent_plugins.py DELEGATES here — it prints "federated from ` +
        `${BUNDLE_REPO} — its Agent Plugins manifests are validated by that repo's own CI, ` +
        `not here", and structurally cannot reach this file. \`claude plugin validate\` does ` +
        `not cover it either: it never reads the root manifest at all.`,
    ).toEqual([]);
  });

  // SABOTAGE PROOF — one case per assertion in agentPluginsProblems(), each
  // mutating the REAL shipping manifest so a case can never drift away from the
  // document it is meant to protect. Every one of these ships GREEN without the
  // schema check above; four of them are the reviewer's original demonstrations,
  // and `category` + `defaultEnabled` are the exact two keys the agentskills
  // marketplace ENTRY for this bundle carries — copy-paste is the likely
  // mistake, and the closed schema forbids them here.
  //
  // Each case asserts the SPECIFIC problem it should provoke, so a case cannot
  // pass for an unrelated reason (e.g. a mutation that happens to also break
  // some other rule). The `extensions` control at the end is the other
  // direction: it proves the closed-key rule is not simply rejecting everything.
  test("the Agent Plugins check rejects each way the manifest can go wrong", () => {
    test.skip(CONSUMER, SKIP_REASON);

    const schema = loadSchema();
    const base = loadManifest(ROOT_MANIFEST, "Agent Plugins 1.0.0").doc;

    const cases = [
      {
        name: "$schema deleted",
        mutate: (m) => delete m.$schema,
        match: /missing required key '\$schema'/,
      },
      {
        name: "$schema pointing at a 2.0.0 path",
        mutate: (m) => {
          m.$schema = "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json";
        },
        match: /'\$schema' must be exactly/,
      },
      {
        name: "marketplace-only 'category' copied in",
        mutate: (m) => {
          m.category = "development";
        },
        match: /unknown top-level key 'category'/,
      },
      {
        name: "marketplace-only 'defaultEnabled' copied in",
        mutate: (m) => {
          m.defaultEnabled = true;
        },
        match: /unknown top-level key 'defaultEnabled'/,
      },
      {
        name: "a top-level 'skills' key (skills are discovered by convention)",
        mutate: (m) => {
          m.skills = ["admin-config-render"];
        },
        match: /unknown top-level key 'skills'/,
      },
      {
        name: "author.github (author is closed: name/email/url only)",
        mutate: (m) => {
          m.author = { ...m.author, github: "Adam-S-Daniel" };
        },
        match: /unknown 'author' key 'github'/,
      },
      {
        name: "keywords as a bare string instead of an array",
        mutate: (m) => {
          m.keywords = "jekyll";
        },
        match: /'keywords' must be an array/,
      },
      {
        name: "keywords holding a non-string element",
        mutate: (m) => {
          m.keywords = ["jekyll", 42];
        },
        match: /'keywords\[1\]' must be a string/,
      },
    ];

    const misses = [];
    for (const c of cases) {
      const doc = JSON.parse(JSON.stringify(base));
      c.mutate(doc);
      const problems = agentPluginsProblems(doc, schema);
      if (!problems.some((p) => c.match.test(p))) {
        misses.push(
          `${c.name}: expected a problem matching ${c.match}, got ` +
            `[${problems.join(" | ") || "NO PROBLEMS AT ALL"}]`,
        );
      }
    }
    expect(
      misses,
      `each sabotage case must be REJECTED by agentPluginsProblems(). A miss means the check ` +
        `has regressed toward a green assertion that asserts nothing — which is the exact hole ` +
        `this file was added to close.`,
    ).toEqual([]);

    // The control. `extensions` IS in the schema (client-specific data, keyed
    // by reverse domain), so a manifest that adds one must stay clean — a
    // closed-key check that rejects it would be over-broad and would start
    // blocking legitimate manifests.
    const withExtensions = JSON.parse(JSON.stringify(base));
    withExtensions.extensions = { "ai.anthropic.claude-code": { note: "allowed by the schema" } };
    expect(
      agentPluginsProblems(withExtensions, schema),
      `'extensions' is schema-allowed — rejecting it would mean the allowed-key set is being ` +
        `invented here rather than derived from the vendored schema.`,
    ).toEqual([]);
  });

  test("every skill's frontmatter parses as YAML and its `name` matches its directory", () => {
    test.skip(CONSUMER, SKIP_REASON);

    const offenders = [];
    for (const { dir, label, error, doc } of parsedSkills()) {
      if (error) {
        offenders.push(`${label} ${error}`);
        continue;
      }
      if (doc.name !== dir) {
        offenders.push(`${label} declares name: ${JSON.stringify(doc.name)} (expected "${dir}")`);
      }
    }
    expect(
      offenders,
      `every skills/<name>/SKILL.md must carry YAML frontmatter whose 'name' equals its ` +
        `DIRECTORY basename. The directory basename is what keys the marketplace upload and ` +
        `the /${BUNDLE_NAME}:<skill> invocation, so a disagreeing frontmatter name ships a ` +
        `skill nobody can invoke under the name they see:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  test(`every skill description is a non-empty string within ${DESCRIPTION_MAX} characters`, () => {
    test.skip(CONSUMER, SKIP_REASON);

    const offenders = [];
    for (const { label, error, doc } of parsedSkills()) {
      if (error) {
        offenders.push(`${label} ${error}`);
        continue;
      }
      // An absent description would make the length check below pass on "" —
      // so require the string before measuring it.
      if (typeof doc.description !== "string" || doc.description.length === 0) {
        offenders.push(`${label} has no non-empty 'description'`);
        continue;
      }
      if (doc.description.length > DESCRIPTION_MAX) {
        offenders.push(
          `${label} description is ${doc.description.length} chars ` +
            `(${doc.description.length - DESCRIPTION_MAX} over)`,
        );
      }
    }
    expect(
      offenders,
      `Agent Skills caps a skill's frontmatter 'description' at ${DESCRIPTION_MAX} characters; ` +
        `past it the skill is rejected on upload. Note the description is measured AFTER YAML ` +
        `parsing, so a folded (\`>-\`) block scalar counts its resolved text, not its source ` +
        `lines:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
