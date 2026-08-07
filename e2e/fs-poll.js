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

module.exports = { contentOrEmpty };
