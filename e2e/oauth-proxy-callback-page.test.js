// @lane: local — renders the OAuth proxy's real callback page (python3) and RUNS
// its inline script in a node:vm sandbox; no browser, no network.
//
// Why execute it: the callback page is where the GitHub access token leaves the
// proxy, and the old page released it to ANY window that answered the
// "authorizing:github" handshake. Matching strings in the HTML (an origin list,
// an `event.source` check) cannot prove the page now WITHHOLDS the token — only
// running the handler against hostile and benign messages can. This also pins
// the claim in oauth-proxy/lambda.py that one regex source string means the
// same thing to Python (which builds it) and JavaScript (which compiles it in
// the page): the allowlist the script enforces here came out of the real
// Python, not a copy of it.
//
// A missing python3 or a failed render FAILS the test — a skipped guard on the
// token handoff is worse than a red one.
const { test, expect } = require("./base");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const vm = require("node:vm");

const PROXY_DIR = path.resolve(__dirname, "..", "oauth-proxy");
const TOKEN = "TEST-TOKEN-VALUE";
const NONCE = "testnonce";
const ALLOWLIST = "https://example.com,https://preview-*.example.com";
// The site's own domain: a `*` entry is honored only beneath it (#535).
const APEX = "example.com";

// `lambda` is a reserved word in Python, so the module is imported by name.
const RENDER_SNIPPET = [
  "import importlib, sys",
  "sys.path.insert(0, sys.argv[1])",
  "page = importlib.import_module('lambda')._success_page(sys.argv[2], sys.argv[3])",
  "sys.stdout.write(page)",
].join("\n");

// Render the success page for an ALLOWED_ORIGINS (and SITE_APEX) value. Throws
// (failing the calling test) when python3 is absent or the render exits
// non-zero.
function renderPage(allowedOrigins, siteApex = APEX) {
  const r = spawnSync("python3", ["-c", RENDER_SNIPPET, PROXY_DIR, TOKEN, NONCE], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-value",
      ALLOWED_ORIGINS: allowedOrigins,
      SITE_APEX: siteApex,
      // Importing the module must not write __pycache__ into the source tree.
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  if (r.error) throw new Error(`could not run python3: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`python3 exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// The body of the page's single nonce'd <script>.
function scriptBody(page) {
  expect(page.match(/<script\b/g), "the page carries exactly one <script>").toHaveLength(1);
  const m = new RegExp(`<script nonce="${NONCE}">([\\s\\S]*?)</script>`).exec(page);
  expect(m, `the <script> must carry nonce="${NONCE}"`).not.toBeNull();
  return m[1];
}

// Run the page script against a hand-built window and return a handle to it.
function boot(page) {
  const posted = []; // every opener.postMessage call: { message, targetOrigin }
  const listeners = []; // the currently registered "message" listeners
  const opener = {
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  const win = {
    opener,
    location: { href: "https://oauth.example.test/prod/callback" },
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn);
      if (type === "message" && i >= 0) listeners.splice(i, 1);
    },
  };
  vm.runInNewContext(scriptBody(page), { window: win });
  return {
    opener,
    posted,
    listeners,
    // What the browser does for a window.postMessage aimed at the popup.
    deliver({ source, origin, data }) {
      for (const fn of [...listeners]) fn({ source, origin, data });
    },
  };
}

const HANDSHAKE = "authorizing:github";

test.describe("OAuth proxy callback page: the token reaches only a configured opener", () => {
  test("on load it announces itself to the opener without the token", () => {
    const popup = boot(renderPage(ALLOWLIST));
    expect(popup.posted).toHaveLength(1);
    // '*' is deliberate here: the announcement carries no secret.
    expect(popup.posted[0]).toEqual({ message: HANDSHAKE, targetOrigin: "*" });
    expect(JSON.stringify(popup.posted)).not.toContain(TOKEN);
  });

  test("the opener's handshake from an origin outside the allowlist gets nothing", () => {
    const popup = boot(renderPage(ALLOWLIST));
    popup.deliver({
      source: popup.opener,
      origin: "https://attacker.example.net",
      data: HANDSHAKE,
    });
    expect(popup.posted).toHaveLength(1);
  });

  for (const origin of [
    "https://example.com.attacker.example.net",
    "https://xexample.com",
    "http://example.com",
    "https://preview-a.b.example.com",
    "https://preview-pr1.example.com.attacker.example.net",
    null,
    "null",
  ]) {
    test(`a look-alike origin (${JSON.stringify(origin)}) gets nothing`, () => {
      const popup = boot(renderPage(ALLOWLIST));
      popup.deliver({ source: popup.opener, origin, data: HANDSHAKE });
      expect(popup.posted).toHaveLength(1);
    });
  }

  test("an allowed origin that is NOT the window that opened the popup gets nothing", () => {
    const popup = boot(renderPage(ALLOWLIST));
    popup.deliver({ source: {}, origin: "https://example.com", data: HANDSHAKE });
    popup.deliver({ source: null, origin: "https://example.com", data: HANDSHAKE });
    expect(popup.posted).toHaveLength(1);
  });

  for (const data of [
    "authorizing:gitlab",
    "authorizing:github ",
    "",
    'authorization:github:success:{"token":"x"}',
    { type: HANDSHAKE },
    undefined,
  ]) {
    test(`the right opener with the wrong message (${JSON.stringify(data)}) gets nothing`, () => {
      const popup = boot(renderPage(ALLOWLIST));
      popup.deliver({ source: popup.opener, origin: "https://example.com", data });
      expect(popup.posted).toHaveLength(1);
    });
  }

  test("the allowed opener gets the token, addressed to exactly its origin, once", () => {
    const popup = boot(renderPage(ALLOWLIST));
    const handshake = { source: popup.opener, origin: "https://example.com", data: HANDSHAKE };
    popup.deliver(handshake);

    expect(popup.posted).toHaveLength(2);
    const { message, targetOrigin } = popup.posted[1];
    expect(targetOrigin).toBe("https://example.com");
    const prefix = "authorization:github:success:";
    expect(message.startsWith(prefix)).toBe(true);
    expect(JSON.parse(message.slice(prefix.length))).toEqual({ token: TOKEN, provider: "github" });

    // The listener removed itself: a replay delivers nothing more.
    expect(popup.listeners).toHaveLength(0);
    popup.deliver(handshake);
    expect(popup.posted).toHaveLength(2);
  });

  test("a per-PR preview origin matched by the wildcard label gets the token", () => {
    const popup = boot(renderPage(ALLOWLIST));
    popup.deliver({
      source: popup.opener,
      origin: "https://preview-pr12.example.com",
      data: HANDSHAKE,
    });
    expect(popup.posted).toHaveLength(2);
    expect(popup.posted[1].targetOrigin).toBe("https://preview-pr12.example.com");
    expect(popup.posted[1].message).toContain(TOKEN);
  });

  test("a wildcard over a public suffix is dropped: its openers never get the token (#535)", () => {
    const popup = boot(renderPage("https://*.pages.example,https://*.co.example,https://example.com"));
    for (const origin of ["https://someone.pages.example", "https://someone.co.example"]) {
      popup.deliver({ source: popup.opener, origin, data: HANDSHAKE });
    }
    expect(popup.posted).toHaveLength(1);
    expect(JSON.stringify(popup.posted)).not.toContain(TOKEN);
    // The literal entry beside them still works.
    popup.deliver({ source: popup.opener, origin: "https://example.com", data: HANDSHAKE });
    expect(popup.posted).toHaveLength(2);
    expect(popup.posted[1].targetOrigin).toBe("https://example.com");
  });

  test("with no SITE_APEX the preview wildcard is dropped, failing closed (#535)", () => {
    const popup = boot(renderPage(ALLOWLIST, ""));
    popup.deliver({ source: popup.opener, origin: "https://preview-pr12.example.com", data: HANDSHAKE });
    expect(popup.posted).toHaveLength(1);
    expect(JSON.stringify(popup.posted)).not.toContain(TOKEN);
  });

  test("ALLOWED_ORIGINS=* is not a wildcard: no origin ever gets the token", () => {
    const popup = boot(renderPage("*"));
    for (const origin of ["https://example.com", "https://attacker.example.net", "http://example.com"]) {
      popup.deliver({ source: popup.opener, origin, data: HANDSHAKE });
    }
    expect(popup.posted).toHaveLength(1);
    expect(JSON.stringify(popup.posted)).not.toContain(TOKEN);
  });
});
