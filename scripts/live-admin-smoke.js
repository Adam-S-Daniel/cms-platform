/*
 * scripts/live-admin-smoke.js
 *
 * Paste-able browser-DevTools-console smoke for the live admin. Open
 * your deployed admin at https://<your-prod-domain>/admin/ in your
 * browser (set CMS_PROD_URL in your shell notes, e.g.
 * https://example.com — the default below is a placeholder), sign in,
 * open DevTools (Cmd-Opt-J / F12 → Console), paste the entire contents
 * of this file, press Enter. The smoke prints a structured table:
 * every layer that has to work for "Publish Now" / "Delete published"
 * to function.
 *
 * The check is read-only against your real OAuth-acquired session — no
 * branch / PR / file mutations. It exists because the Playwright e2e
 * suite seeds a PAT in localStorage and skips the real OAuth flow, so
 * a green CI run is NOT proof that buttons work for you.
 *
 *   ✓  green: that layer is wired correctly.
 *   ✗  red:   that layer is the most likely cause of "click does nothing".
 *   ?  amber: couldn't determine; usually means you're not signed in yet.
 *
 * If anything is red, the line tells you exactly what to do.
 *
 * Prod admin URL resolution (browser-paste context): this script runs
 * in the console of whatever page you opened, so it reports the live
 * origin from `location.origin`. When invoked under Node (e.g. a
 * wrapper), the prod URL is read from process.env.CMS_PROD_URL or the
 * first CLI arg, falling back to the instructional placeholder
 * "https://<your-prod-domain>".
 */
(async function liveAdminSmoke() {
  // Instructional default — replace via CMS_PROD_URL / argv when run
  // under Node, or just rely on location.origin in the browser.
  const PROD_URL_DEFAULT = "https://<your-prod-domain>";
  const prodUrl =
    (typeof location !== "undefined" && location.origin) ||
    (typeof process !== "undefined" &&
      ((process.env && process.env.CMS_PROD_URL) || (process.argv && process.argv[2]))) ||
    PROD_URL_DEFAULT;

  const out = [];
  const ok = (k, v, hint) => out.push({ check: k, status: "✓", detail: v, hint: hint || "" });
  const bad = (k, v, hint) => out.push({ check: k, status: "✗", detail: v, hint });
  const meh = (k, v, hint) => out.push({ check: k, status: "?", detail: v, hint });

  ok("admin origin", prodUrl);

  // ── 1. Shim is loaded ─────────────────────────────────────────────
  if (window.__publishViaAutoMergeInstalled) {
    ok("shim installed", "window.__publishViaAutoMergeInstalled is true");
  } else {
    bad(
      "shim installed",
      "window.__publishViaAutoMergeInstalled is falsy",
      "publish-via-auto-merge.js did not load. Hard-refresh (Cmd-Shift-R) to bust the 24h cache.",
    );
  }

  // ── 2. window.fetch is wrapped ────────────────────────────────────
  const fetchSrc = String(window.fetch);
  if (fetchSrc.includes("origFetch") || fetchSrc.includes("matchers")) {
    ok("fetch wrapped", "window.fetch is the shim wrap");
  } else {
    bad(
      "fetch wrapped",
      "window.fetch looks native (" + fetchSrc.slice(0, 80) + ")",
      "Shim ran but the wrap was clobbered later. Check for late scripts that reassign window.fetch.",
    );
  }

  // ── 3. Decap auth in localStorage ─────────────────────────────────
  let authBlob = null;
  try {
    const raw = localStorage.getItem("decap-cms-user");
    authBlob = raw ? JSON.parse(raw) : null;
  } catch {
    /* ignore */
  }
  if (!authBlob || !authBlob.token) {
    meh(
      "decap auth",
      "localStorage[decap-cms-user] missing or no .token",
      "You are not signed in. Sign in via the admin UI, then re-run this smoke.",
    );
    return print();
  } else {
    ok("decap auth", `signed in as ${authBlob.login || "(unknown login)"}`);
  }

  // ── 4. Token's GitHub scopes ──────────────────────────────────────
  // GitHub returns granted scopes in the X-OAuth-Scopes response header
  // on any authenticated API call.
  let scopes;
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: "token " + authBlob.token },
    });
    scopes = (r.headers.get("X-OAuth-Scopes") || "").toLowerCase();
  } catch (e) {
    bad(
      "token scopes",
      "failed to query api.github.com/user: " + e.message,
      "OAuth proxy or network issue. Check Network tab for the actual response.",
    );
    return print();
  }
  const scopeList = scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  ok("token scopes", JSON.stringify(scopeList));
  const want = ["repo", "user"];
  for (const s of want) {
    const have =
      scopeList.includes(s) ||
      (s === "user" && scopeList.some((x) => x.startsWith("user"))) ||
      (s === "repo" && scopeList.some((x) => x === "repo" || x.startsWith("repo:")));
    if (have) {
      ok("  has " + s + " scope", "yes");
    } else {
      bad("  has " + s + " scope", "NO", "CMS API calls will fail. Re-authenticate.");
    }
  }

  print();

  function print() {
    console.log(
      "%c live-admin-smoke ",
      "background:#1f2937;color:#fff;font-weight:bold;padding:2px 8px",
    );
    console.table(out);
    const reds = out.filter((o) => o.status === "✗");
    if (reds.length) {
      console.warn("first failure:", reds[0]);
    } else {
      console.log(
        "%c all green — if buttons still don't work, capture the Network tab while clicking and share",
        "color:#10b981",
      );
    }
  }
})();
