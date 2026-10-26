// Preparation only: the browser regression never fetches a bundle or falls back
// to the network. Use the exact index-local.html pin and verify its SRI first.
const fs = require("node:fs");
const path = require("node:path");
const { BUNDLE_CACHE, readShell, verifyBundle } = require("./decap-caret-diagnostic");

async function prepare() {
  const { pin } = await readShell();
  const response = await fetch(pin.src, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Decap bundle download failed (HTTP ${response.status})`);
  const bundle = verifyBundle(Buffer.from(await response.arrayBuffer()), pin.integrity);
  fs.mkdirSync(path.dirname(BUNDLE_CACHE), { recursive: true });
  fs.writeFileSync(BUNDLE_CACHE, bundle);
  console.log("Prepared the pinned, SRI-verified Decap diagnostic bundle");
}

if (require.main === module) {
  prepare().catch(() => {
    console.error("Decap diagnostic preparation failed");
    process.exitCode = 1;
  });
}

module.exports = { prepare };
