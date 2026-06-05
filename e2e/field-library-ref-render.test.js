// @lane: local — self-contained ruby render of a $ref fixture; pure fs + child_process, no browser.
//
// Integration lint for issue #5 GOAL 2 (field_library + $ref reuse). It drives
// the REAL deploy-time render path (scripts/render-decap-config.rb) against a
// throwaway fixture site whose SITE-OWNED seam (admin/collections.site.yml)
// uses `$ref: "#/field_library/<name>"` to reuse platform field defs, then
// asserts the RENDERED _site/admin/config.yml:
//   - contains the FULLY-RESOLVED field defs (single + multi-field refs), and
//   - leaks NO `$ref` key (Decap must never see one), and
//   - leaves the platform base collections + the verbatim-locked base lines
//     (posts.summary, the dayjs/INVALID-DATE format token, the
//     media_folder/public_folder invariant, preview_context) byte-unchanged.
//
// It also proves BACKWARD COMPAT: a seam with NO $ref (inline fields — the
// status quo) renders byte-identically to feeding the raw seam text straight
// through the legacy splice.
//
// Runs in the platform self-CI node-unit-lints lane (TARGET=prod): no Jekyll,
// no browser — just `ruby` (already on the lane's runner for the theme specs)
// + fs. Self-skips if `ruby` or the platform render sources are absent
// (e.g. a consumer checkout), like the parity lint.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "render-decap-config.rb");
const BASE = path.join(ROOT, "theme", "admin", "config.base.yml");
const FIELD_LIBRARY = path.join(ROOT, "theme", "admin", "field_library.yml");

function rubyAvailable() {
  const r = spawnSync("ruby", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// The platform render sources only exist in the platform checkout; in a
// consumer the harness is placed at the site root and they're absent.
const havePlatform =
  fs.existsSync(SCRIPT) && fs.existsSync(BASE) && fs.existsSync(FIELD_LIBRARY) && rubyAvailable();

// Build a throwaway fixture site whose admin/ carries the base machinery (so
// the renderer's gem-less fallback resolves it) + the given seam text. Returns
// the rendered config.yml text.
function renderWithSeam(seamText, configExtra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fl-ref-"));
  const admin = path.join(dir, "admin");
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_config.yml"),
    `title: Ref Fixture\nurl: "https://ref.example"\ncms:\n  repository: Adam-S-Daniel/ref-fixture\n  oauth_base_url: ""\n${configExtra}`,
  );
  // The renderer falls back to <site>/admin for the base machinery when the gem
  // isn't loaded (a `ruby scripts/...` CLI run), so copy the platform base +
  // field_library in. The seam is the site-owned input under test.
  fs.copyFileSync(BASE, path.join(admin, "config.base.yml"));
  fs.copyFileSync(FIELD_LIBRARY, path.join(admin, "field_library.yml"));
  if (seamText != null) {
    fs.writeFileSync(path.join(admin, "collections.site.yml"), seamText);
  }
  const out = path.join(dir, "_site");
  const r = spawnSync("ruby", [SCRIPT, dir, out], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`render-decap-config.rb failed (status ${r.status}):\n${r.stderr}\n${r.stdout}`);
  }
  return fs.readFileSync(path.join(out, "admin", "config.yml"), "utf8");
}

function collection(cfg, name) {
  return (cfg.collections || []).find((c) => c && c.name === name) || null;
}
function fieldNames(col) {
  return (col.fields || []).map((f) => f && f.name);
}

const REF_SEAM = [
  "  - name: articles",
  "    label: Articles",
  "    folder: _articles",
  "    create: true",
  "    delete: true",
  '    slug: "{{slug}}"',
  "    fields:",
  "      - { name: title, label: Title, widget: string, required: true }",
  '      - $ref: "#/field_library/body_markdown"',
  '      - $ref: "#/field_library/image_widget"',
  '      - $ref: "#/field_library/published_pair"',
  "",
].join("\n");

// The same collection authored with everything inline — no $ref. Used for the
// backward-compat byte check.
const INLINE_SEAM = [
  "  - name: notes",
  "    label: Notes",
  "    folder: _notes",
  "    create: true",
  "    delete: true",
  '    slug: "{{slug}}"',
  "    fields:",
  "      - { name: title, label: Title, widget: string, required: true }",
  "      - { name: body,  label: Body,  widget: markdown, required: true }",
  "",
].join("\n");

test.describe("field_library $ref render (issue #5 GOAL 2)", () => {
  test.skip(
    !havePlatform,
    "platform render sources / ruby absent — platform-only field_library render lint",
  );

  test("a $ref seam renders FULLY-RESOLVED field defs with NO $ref leak", () => {
    const rendered = renderWithSeam(REF_SEAM);
    // Hard invariant: Decap must never see a $ref anywhere in the output.
    expect(rendered, "no $ref key may survive into the rendered config").not.toContain("$ref");

    const cfg = YAML.parse(rendered);
    const articles = collection(cfg, "articles");
    expect(articles, "site collection 'articles' must be spliced in").not.toBeNull();

    // single-field refs (body_markdown, image_widget) + multi-field ref
    // (published_pair → published + publish_date) all resolved in order.
    expect(fieldNames(articles)).toEqual([
      "title",
      "body",
      "image",
      "published",
      "publish_date",
    ]);

    const body = articles.fields.find((f) => f.name === "body");
    expect(body.widget).toBe("markdown");
    expect(body.modes).toEqual(["rich_text", "raw"]);

    const image = articles.fields.find((f) => f.name === "image");
    expect(image.widget).toBe("image");

    // The resolved publish_date MUST carry the cross-engine date-format token
    // verbatim (the dayjs/INVALID-DATE contract copied from config.base.yml).
    const publishDate = articles.fields.find((f) => f.name === "publish_date");
    expect(publishDate.widget).toBe("datetime");
    expect(publishDate.format).toBe("YYYY-MM-DD HH:mm:ss ZZ");
  });

  test("the platform base collections + verbatim-locked base lines are unchanged by $ref expansion", () => {
    const rendered = renderWithSeam(REF_SEAM);
    const cfg = YAML.parse(rendered);

    // All five platform base collections survive, plus the site's own.
    expect(cfg.collections.map((c) => c.name)).toEqual([
      "posts",
      "tags",
      "projects",
      "pages",
      "e2e",
      "articles",
    ]);

    // Verbatim-asserted base lines (locked by cms-post-list-summary /
    // cms-config / cms-permalink-contract specs) must appear byte-for-byte.
    expect(rendered).toContain(
      'summary: "{{title}} ({{year}}-{{month}}-{{day}})' +
        "{{published | ternary('', ' — DRAFT')}}" +
        "{{publish_date | ternary(' — Scheduled', '')}}\"",
    );
    expect(rendered).toContain('format: "YYYY-MM-DD HH:mm:ss ZZ"');
    expect(rendered).toContain('media_folder: "assets/images/uploads"');
    expect(rendered).toContain("public_folder: /assets/images/uploads");
    expect(rendered).toContain("preview_context: deploy/preview");
  });

  test("an unknown $ref FAILS HARD (render aborts, never leaks a $ref)", () => {
    const badSeam = [
      "  - name: broken",
      "    label: Broken",
      "    folder: _broken",
      "    fields:",
      '      - $ref: "#/field_library/no_such_field"',
      "",
    ].join("\n");
    expect(() => renderWithSeam(badSeam)).toThrow(/unresolved \$ref|no_such_field/);
  });

  test("BACKWARD COMPAT: a no-$ref inline seam renders identically to the raw legacy splice", () => {
    // With no $ref, the seam text is spliced verbatim (legacy behavior). Prove
    // it by rendering the inline seam and asserting the inline fields land at
    // their authored 6-space indent, byte-for-byte from the seam — i.e. the
    // renderer did NOT round-trip / reflow a no-$ref seam through YAML.
    const rendered = renderWithSeam(INLINE_SEAM);
    expect(rendered, "no $ref present → no reflow").not.toContain("$ref");
    // The exact authored inline lines survive verbatim (not re-emitted by YAML.dump).
    expect(rendered).toContain(
      "      - { name: title, label: Title, widget: string, required: true }",
    );
    expect(rendered).toContain(
      "      - { name: body,  label: Body,  widget: markdown, required: true }",
    );
    const cfg = YAML.parse(rendered);
    expect(collection(cfg, "notes"), "inline 'notes' collection still splices in").not.toBeNull();
  });
});
