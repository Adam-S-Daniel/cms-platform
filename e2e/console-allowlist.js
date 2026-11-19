// Console noise that is never a content regression, shared by
// e2e/console-clean.spec.js and e2e/page-frame.spec.js.
// Errors that are expected on the local dev server / preview but never on
// production proper, or that are noise from environment-specific assets.
// Anything matched here is filtered out *before* the assertion.
function isAllowlisted(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Browsers emit a 404 for /favicon.ico when no favicon is shipped at the
  // exact root path. The site uses a custom icon path in the head, so the
  // implicit /favicon.ico request is harmless.
  if (lower.includes("/favicon.ico")) return true;

  // CloudWatch RUM is production-only (gated by JEKYLL_ENV=production AND a
  // non-empty app_monitor_id). On preview/local the snippet isn't emitted at
  // all — but if a future config wires it up before the local stack is ready,
  // CORS / Failed to fetch errors against the AWS endpoints are not a content
  // regression. Allowlist by hostname fragments.
  if (lower.includes("cognito")) return true;
  if (lower.includes("cloudwatch-rum")) return true;
  const hosts = (lower.match(/https?:\/\/[^\s"'<>)]+/g) || []).flatMap((u) => {
    try {
      return [new URL(u).hostname];
    } catch {
      return [];
    }
  });
  if (hosts.some((h) => h === "rum.us-east-1.amazonaws.com" || h.endsWith(".rum.us-east-1.amazonaws.com"))) return true;

  return false;
}

module.exports = { isAllowlisted };
