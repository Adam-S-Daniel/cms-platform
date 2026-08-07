/*
 * Reading a file ANOTHER process is writing.
 *
 * decap-server CREATES an entry file and then fills it, so a spec that waits
 * with `expect.poll(() => fs.existsSync(file))` and then reads can win the race
 * and get `""`:
 *
 *     Expected substring: "title: Decap Project CRUD Smoke"
 *     Received string:    ""
 *
 * That is the "decap-server file-write race" the config's `retries: 1` exists
 * for. It got likelier once each project job ran 6 workers, so the waits now
 * poll the CONTENT they expect instead of mere existence — which is both the
 * correct wait and a better failure message when the content never arrives.
 *
 *     await expect.poll(() => contentOrEmpty(FILE), { timeout: 60_000 })
 *       .toContain(`title: ${TITLE}`);
 *     const saved = contentOrEmpty(FILE);
 *
 * When the PATH itself is discovered (Decap names the file after the slug AND
 * the date, so specs locate it with a readdir helper), poll `fileReady` on the
 * helper instead — it defers to the same content check once a path exists:
 *
 *     await expect.poll(() => fileReady(findSmokePostFile), { timeout: 60_000 })
 *       .toBe(true);
 *     const postPath = findSmokePostFile();
 *
 * This matters most where the read feeds a WRITE back to the same file
 * (cms-html-embed / cms-inline-image patch the body Decap just saved): an empty
 * read there does not merely fail an assertion, it overwrites the entry with
 * front-matter-less content and leaves a corrupt page on disk for the retry.
 */
const fs = require("node:fs");

// The file's content, or "" when it does not exist yet. Any other read error
// (permissions, a directory, EIO) is a real problem and still throws.
function contentOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

// True once `find` resolves to a path whose content carries `needle`.
// `needle` defaults to the YAML front-matter delimiter every Decap entry opens
// with, so the default question is "has decap-server finished writing this?".
// Accepts a finder function (the readdir helpers) or a fixed path.
function fileReady(find, needle = "---") {
  const file = typeof find === "function" ? find() : find;
  if (!file) return false;
  return contentOrEmpty(file).includes(needle);
}

module.exports = { contentOrEmpty, fileReady };
