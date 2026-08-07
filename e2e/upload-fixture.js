/*
 * Per-spec upload fixtures.
 *
 * Decap names an uploaded asset after the basename it is handed, and every
 * @admin-write image spec then GLOBS `assets/images/uploads/` for that basename
 * — both to assert on the upload and to delete it afterwards. Three specs were
 * handing Decap the SAME `e2e/fixtures/tiny-pixel.png`, so one spec's cleanup
 * could delete another spec's in-flight upload:
 *
 *   cms-image-upload's cleanup unlinks the first `tiny-pixel*.png` it finds
 *   → cms-featured-image-lifecycle's "replace with B, A still on disk"
 *     assertion sees 0 files.
 *
 * Invisible while the admin project ran at 2 workers (the two specs rarely
 * overlapped); a reproducible flake the moment it ran one worker per vCPU.
 *
 * `uploadFixture(source, basename)` hands back a temp copy under a unique
 * basename, so each spec's glob can only ever see its own uploads. Keep the
 * basename STABLE per spec (not per run) so a crashed run's leftover is swept
 * by the same prefix on the next one.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function uploadFixture(source, basename) {
  // One temp dir per (spec, basename) so concurrent workers can't race on the
  // copy itself; the basename — what Decap stores — stays deterministic.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-upload-"));
  const dest = path.join(dir, basename);
  fs.copyFileSync(source, dest);
  return dest;
}

module.exports = { uploadFixture };
