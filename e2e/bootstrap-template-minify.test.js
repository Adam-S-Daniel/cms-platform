// @lane: local — runs infrastructure/bootstrap/minify-template.rb (the same
// script deploy.sh runs) over the real bootstrap template. No network, no AWS.
//
// THE GAP: v0.1.125 grew infrastructure/bootstrap/template.yaml to 60,694
// bytes, past the AWS CLI's 51,200-byte limit for a template sent inline, and
// nothing noticed until a real deploy failed: cfn-lint does not check size.
// deploy.sh now sends a minified copy (comments and layout dropped through a
// real YAML parse); this file is the growth alarm and the safety proof.
//
// WHAT THIS FILE PROVES
//   - SIZE: the minified template is at most 48,000 bytes. That is headroom
//     under the 51,200-byte limit (where deploy.sh itself refuses), so growth
//     goes red here before it breaks a deploy.
//   - EQUIVALENCE: the minified template parses, with a second and independent
//     YAML implementation (the `yaml` package, not libyaml), to exactly the
//     same node tree as the original: every tag (!Sub, !Ref, !If, !GetAtt
//     ...), every scalar's value and style (so block scalars such as a
//     FunctionCode body are byte for byte), key order. This is the property
//     that makes minifying safe.
//   - NEGATIVE CONTROLS: the same comparison goes red on a minified copy with
//     one tag dropped, on one with a line removed from a block scalar, and on
//     the "obvious" line filter that strips comment and blank lines, which
//     looks equivalent and is not.
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: a consumer has no
// infrastructure/bootstrap/ of its own (it ships a delegating wrapper).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const BOOTSTRAP = path.join(REPO_ROOT, "infrastructure", "bootstrap");
const MINIFIER = path.join(BOOTSTRAP, "minify-template.rb");
const TEMPLATE = path.join(BOOTSTRAP, "template.yaml");
// The AWS CLI's (and CloudFormation's) limit on a template sent inline.
const INLINE_LIMIT_BYTES = 51200;
// Where this test goes red: 3,200 bytes of warning before deploys break.
const HEADROOM_LIMIT_BYTES = 48000;

let original;
let minified;

test.beforeAll(() => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-minify-"));
  try {
    const out = path.join(scratch, "template.yaml");
    const r = spawnSync("ruby", [MINIFIER, TEMPLATE, out], { encoding: "utf8" });
    if (r.error) throw new Error(`could not run ruby (deploy.sh needs it too): ${r.error.message}`);
    if (r.status !== 0) throw new Error(`minify-template.rb exited ${r.status}: ${r.stderr}`);
    original = fs.readFileSync(TEMPLATE, "utf8");
    minified = fs.readFileSync(out, "utf8");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// Everything a CloudFormation loader reads, nothing that is layout: tags,
// anchors, scalar values with their style (plain/quoted/block decides how a
// value resolves and what a block holds), and structure in order.
function nodeTree(text) {
  const doc = YAML.parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length) throw new Error(`YAML errors: ${doc.errors.map((e) => e.message).join("; ")}`);
  const walk = (node) => {
    if (node == null) return null;
    if (YAML.isAlias(node)) return { alias: node.source };
    const base = { tag: node.tag ?? null, anchor: node.anchor ?? null };
    if (YAML.isMap(node)) return { ...base, map: node.items.map((p) => [walk(p.key), walk(p.value)]) };
    if (YAML.isSeq(node)) return { ...base, seq: node.items.map(walk) };
    if (YAML.isScalar(node)) return { ...base, type: node.type, source: node.source ?? null, value: node.value };
    throw new Error(`unexpected YAML node ${node?.constructor?.name}`);
  };
  return walk(doc.contents);
}

const countTags = (tree, counts = {}) => {
  if (tree && typeof tree === "object") {
    if (typeof tree.tag === "string") counts[tree.tag] = (counts[tree.tag] || 0) + 1;
    for (const v of Object.values(tree)) countTags(v, counts);
  }
  return counts;
};

test("size: the minified template stays under 48,000 bytes (the inline limit is 51,200)", () => {
  // BYTES, not characters: the limit is on the encoded size, and the template
  // carries non-ASCII prose.
  const raw = Buffer.byteLength(original, "utf8");
  const bytes = Buffer.byteLength(minified, "utf8");
  test.info().annotations.push({ type: "template-bytes", description: `raw ${raw}, minified ${bytes}` });
  expect(
    bytes,
    `minified template.yaml is ${bytes} bytes; over ${HEADROOM_LIMIT_BYTES} it is too close to the ` +
      `${INLINE_LIMIT_BYTES}-byte inline limit deploy.sh refuses at. Comments are free; shrink the content.`,
  ).toBeLessThanOrEqual(HEADROOM_LIMIT_BYTES);
});

test("equivalence: the minified template parses to exactly the original's node tree", () => {
  const before = nodeTree(original);
  const after = nodeTree(minified);
  expect(after).toEqual(before);
  // The comparison really sees the short-form tags (a parser that dropped them
  // would compare two tag-free trees as equal).
  const tags = countTags(before);
  for (const tag of ["!Sub", "!Ref", "!If", "!GetAtt"]) {
    expect(tags[tag], `${tag} nodes in the original`).toBeGreaterThan(0);
  }
  expect(countTags(after)).toEqual(tags);
  // And the minifier did its job: no comment survives.
  expect(minified.length).toBeLessThan(original.length);
});

test("negative control: dropping one tag is caught", () => {
  const lossy = minified.replace("!Sub ", "");
  expect(lossy).not.toBe(minified);
  expect(nodeTree(lossy)).not.toEqual(nodeTree(original));
});

test("negative control: removing a line from a block scalar is caught", () => {
  // The first FunctionCode body is a literal block; drop its second line.
  const start = minified.indexOf("FunctionCode: !Sub |\n");
  expect(start, "a FunctionCode literal block").toBeGreaterThan(-1);
  const lines = minified.slice(start).split("\n");
  lines.splice(2, 1);
  const lossy = minified.slice(0, start) + lines.join("\n");
  expect(nodeTree(lossy)).not.toEqual(nodeTree(original));
});

test("negative control: a line filter dropping comment and blank lines is NOT equivalent", () => {
  const filtered = original
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");
  expect(nodeTree(filtered)).not.toEqual(nodeTree(original));
});
