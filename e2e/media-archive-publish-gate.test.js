// @lane: local — pure-fs lint of the private media-archive publish path.
/*
 * The archive publishes a PDF onto the public web only when an editor has
 * ticked `pdf_public` on that entry. Three things have to hold for that to
 * mean anything, and each has already been observed failing:
 *
 *   1. ORDERING. The publish step must sit after the AWS credentials (the
 *      archive is private) and before the S3 sync (the sync uploads the tree
 *      the step writes into). After the sync it uploads nothing, silently.
 *   2. The bucket must be genuinely private, with a READ-ONLY grant. The
 *      deploy copies a PDF out; it must never be able to overwrite or delete
 *      the only copy of a rendered capture.
 *   3. Two shell traps in the publish script that both fail OPEN — they make
 *      the script publish NOTHING while exiting 0. Both were caught by
 *      negative controls before shipping, and neither is visible by reading.
 *
 * Registered in PLATFORM_META_SPECS: it reads the platform's own workflows,
 * CloudFormation template and scripts, none of which exist on a consumer.
 */
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const REPO = path.join(__dirname, "..");
const SCRIPT_REL = "scripts/publish-opted-in-pdfs.sh";
const SCRIPT = path.join(REPO, SCRIPT_REL);
const TEMPLATE = path.join(REPO, "infrastructure/bootstrap/template.yaml");

const stepNames = (job) => (job.steps || []).map((s) => s.name || s.uses || "");

// Slice one top-level `Resources:` entry out of the CloudFormation template by
// INDENTATION. Splitting on the next expected sibling name (the first draft of
// this lint) silently returns the whole rest of the file when that sibling is
// absent — so the block then contains other buckets, and every assertion about
// "this bucket" is really about all of them.
function resourceBlock(tpl, name) {
  const lines = tpl.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `no resource named ${name}`).toBeGreaterThan(-1);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "" && !/^ {4}/.test(l)) break; // dedented to a sibling
    out.push(l);
  }
  return out.join("\n");
}

// The script's own comments deliberately QUOTE the anti-patterns they warn
// about, so a lint that greps raw source matches the warning and calls it a
// violation. Strip whole-line shell comments first.
function shellCode(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

function deployJob(file, jobName) {
  const doc = parseYaml(readWorkflow(file));
  const job = doc.jobs[jobName];
  expect(job, `${file} has no '${jobName}' job`).toBeTruthy();
  return job;
}

test("the publish script exists and is executable", () => {
  expect(fs.existsSync(SCRIPT), `${SCRIPT_REL} is missing`).toBe(true);
  // 0o111 — any execute bit. The workflow invokes it via `bash <path>`, so this
  // is about it staying a runnable script rather than drifting into a snippet.
  expect(fs.statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
});

for (const [file, job, siteDir] of [
  ["deploy-production.yml", "deploy", "./_site"],
  ["deploy-preview.yml", "deploy-preview", "./_site_preview"],
]) {
  test(`${file}: media_archive_bucket is an optional input defaulting to empty`, () => {
    const doc = parseYaml(readWorkflow(file));
    const inputs = doc.on.workflow_call.inputs;
    expect(inputs.media_archive_bucket, `${file} must accept media_archive_bucket`).toBeTruthy();
    // Empty default is what keeps every site that has NOT adopted the archive
    // deploying exactly as before.
    expect(inputs.media_archive_bucket.default).toBe("");
    expect(inputs.media_archive_bucket.required ?? false).toBe(false);
  });

  test(`${file}: publish step runs after credentials and before the S3 sync`, () => {
    const names = stepNames(deployJob(file, job));
    const publish = names.findIndex((n) => /Publish opted-in archived PDFs/.test(n));
    const creds = names.findIndex((n) => /Configure AWS credentials/.test(n));
    const sync = names.findIndex((n) => /^Sync to S3/.test(n));
    expect(publish, `${file} has no publish step`).toBeGreaterThan(-1);
    expect(creds, `${file} has no credentials step`).toBeGreaterThan(-1);
    expect(sync, `${file} has no sync step`).toBeGreaterThan(-1);
    expect(publish, `${file}: publish must come AFTER the credentials`).toBeGreaterThan(creds);
    expect(publish, `${file}: publish must come BEFORE the sync`).toBeLessThan(sync);
  });

  test(`${file}: publish step targets that lane's build directory`, () => {
    const step = (deployJob(file, job).steps || []).find((s) =>
      /Publish opted-in archived PDFs/.test(s.name || ""),
    );
    // The preview lane builds into _site_preview; passing _site there would
    // publish into a directory nothing uploads.
    expect(step.run).toContain(SCRIPT_REL.replace("scripts/", "scripts/"));
    expect(step.run).toContain(siteDir);
    expect(step.if).toContain("media_archive_bucket");
  });
}

test("the archive bucket blocks public access on all four axes", () => {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  const block = resourceBlock(tpl, "MediaArchiveBucket");
  for (const axis of [
    "BlockPublicAcls: true",
    "BlockPublicPolicy: true",
    "IgnorePublicAcls: true",
    "RestrictPublicBuckets: true",
  ]) {
    expect(block, `MediaArchiveBucket must set ${axis}`).toContain(axis);
  }
  // No bucket policy may grant read on it — the three sibling buckets each have
  // one, and copying that shape here would undo the whole design.
  expect(tpl).not.toContain("MediaArchiveBucketPolicy");
  expect(block).not.toContain("WebsiteConfiguration");
});

test("the archive IAM grant is read-only", () => {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  // The conditional statement is the one that names the condition inside an
  // `!If` — index it by that shape, not by counting occurrences of the
  // condition name (which also appears in Conditions: and on the bucket).
  const grant = tpl.split("- !If\n                - ShouldCreateMediaArchive\n")[1];
  expect(grant, "no conditional MediaArchive IAM statement found").toBeTruthy();
  const stmt = grant.split('- !Ref "AWS::NoValue"')[0];
  expect(stmt).toContain("s3:GetObject");
  expect(stmt).toContain("s3:ListBucket");
  for (const write of ["s3:PutObject", "s3:DeleteObject", "s3:DeleteBucket"]) {
    expect(stmt, `the archive grant must not include ${write}`).not.toContain(write);
  }
});

test("the ruby -e body is ASCII-only", () => {
  // `ruby -e` parses its argument as US-ASCII. One en dash inside the body is
  // `invalid multibyte char` — a COMPILE error, which (before the next test's
  // fix) exited 0 having published nothing.
  const src = fs.readFileSync(SCRIPT, "utf8");
  const body = src.split("ruby -ryaml -rdate -e '")[1].split("' \"$COLLECTION_DIR\"")[0];
  const offenders = [...body].filter((ch) => ch.charCodeAt(0) > 127);
  expect(offenders.join(""), "non-ASCII inside the ruby -e body").toBe("");
});

test("the parser's exit status is checked, not masked by mapfile", () => {
  // `mapfile -t X < <(ruby ...)` reports mapfile's status, never ruby's, so a
  // dead parser reads as "nothing opted in" and the deploy quietly unpublishes
  // every cleared PDF. Route through a file and test the command instead.
  const src = shellCode(fs.readFileSync(SCRIPT, "utf8"));
  expect(src, "mapfile must not consume ruby via process substitution").not.toMatch(
    /mapfile[^\n]*<\s*<\(\s*ruby/,
  );
  expect(src).toMatch(/if\s+!\s+ruby\b/);
});

test("only a real boolean true opens the gate", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  // A YAML string "false" is truthy in most languages; the layout guard and
  // this script must agree that ONLY `true` publishes.
  expect(src).toMatch(/fm\["pdf_public"\]\s*==\s*true/);
});
