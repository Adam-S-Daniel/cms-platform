// @lane: local — pure-Node unit tests for the email-to-draft poller
// (infrastructure/email-draft-poller): the Lambda's JMAP -> repository_dispatch
// flow driven by a fake fetch and an injected secrets getter, plus a parse of
// its SAM template with the real `yaml` package. No network, no browser, no
// AWS. Platform-only (consumers have no infrastructure/email-draft-poller), so
// it is registered in playwright.config.js PLATFORM_META_SPECS.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const YAML = require("yaml");
const { test, expect } = require("./base");

const DIR = path.join(__dirname, "..", "infrastructure/email-draft-poller");
const loadPoller = () => import(pathToFileURL(path.join(DIR, "src/index.mjs")).href);

const FASTMAIL_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:poller/fastmail-AbCdEf";
const APP_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:poller/github-app-AbCdEf";
const FASTMAIL_TOKEN = "fmu1-FAKE-FASTMAIL-TOKEN-0001";
const INSTALL_TOKEN = "ghs_FAKEINSTALLATIONTOKEN0001";
const SUBJECT = "Secret subject line about a draft";
const API_URL = "https://jmap.example.com/api/";
const ACCOUNT = "u1234";
const NOW = Date.parse("2026-11-06T12:00:00Z");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs1", format: "pem" });

// Mailboxes: two same-named leaves under different parents, so only the full
// path picks the right one.
const MAILBOXES = [
  { id: "mb-root", name: "Create draft", parentId: null },
  { id: "mb-ad", name: "adamdaniel.ai", parentId: "mb-root" },
  { id: "mb-other", name: "Other", parentId: null },
  { id: "mb-other-ad", name: "adamdaniel.ai", parentId: "mb-other" },
  { id: "mb-ad-processed", name: "Processed", parentId: "mb-ad" },
];

const ROUTES = [{ mailbox: "Create draft/adamdaniel.ai", repo: "Adam-S-Daniel/adamdaniel.ai" }];

// A scripted Fastmail + GitHub. `opts.emails` maps mailbox id -> email ids;
// `opts.dispatchStatus` is the dispatch reply status.
function fakeWorld(opts = {}) {
  const calls = [];
  const emails = opts.emails || { "mb-ad": ["e1"] };
  const keyworded = [];
  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });
  async function fetch(url, init = {}) {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = (init.headers && init.headers.authorization) || "";
    calls.push({ url, method, body, auth });
    if (url === "https://api.fastmail.com/jmap/session") {
      expect(auth).toBe(`Bearer ${FASTMAIL_TOKEN}`);
      return reply(200, {
        apiUrl: API_URL,
        primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT },
      });
    }
    if (url === API_URL) {
      const [name, args, id] = body.methodCalls[0];
      if (name === "Mailbox/get") return reply(200, { methodResponses: [[name, { list: MAILBOXES }, id]] });
      if (name === "Email/query") {
        const ids = emails[args.filter.inMailbox] || [];
        // The subject is in the world, never asked for, never logged.
        return reply(200, { methodResponses: [[name, { ids, subject: SUBJECT }, id]] });
      }
      if (name === "Email/set") {
        const [emailId] = Object.keys(args.update);
        keyworded.push({ emailId, patch: args.update[emailId] });
        return reply(200, { methodResponses: [[name, { updated: { [emailId]: null } }, id]] });
      }
    }
    let m;
    if ((m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/installation$/))) {
      return reply(200, { id: 4242 });
    }
    if (url === "https://api.github.com/app/installations/4242/access_tokens") {
      return reply(201, { token: INSTALL_TOKEN, expires_at: new Date(NOW + 3600e3).toISOString() });
    }
    if ((m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/dispatches$/))) {
      return reply(opts.dispatchStatus || 204, opts.dispatchStatus ? { message: SUBJECT } : undefined);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }
  return { fetch, calls, keyworded };
}

async function makeHandler(world, routes = ROUTES) {
  const { createHandler } = await loadPoller();
  const logs = [];
  const secrets = {
    [FASTMAIL_ARN]: FASTMAIL_TOKEN,
    [APP_ARN]: JSON.stringify({ client_id: "Iv1.fakeclientid", private_key: PRIVATE_PEM }),
  };
  const handler = createHandler({
    fetch: world.fetch,
    getSecret: async (arn) => {
      if (!(arn in secrets)) throw new Error("unknown secret");
      return secrets[arn];
    },
    now: () => NOW,
    log: (line) => logs.push(line),
    env: {
      ROUTES: JSON.stringify(routes),
      FASTMAIL_TOKEN_SECRET_ARN: FASTMAIL_ARN,
      GITHUB_APP_SECRET_ARN: APP_ARN,
    },
  });
  return { handler, logs };
}

function expectCleanLogs(logs) {
  expect(logs).toHaveLength(1);
  const text = logs.join("\n");
  for (const forbidden of [FASTMAIL_TOKEN, INSTALL_TOKEN, SUBJECT, "@", "BEGIN"]) {
    expect(text, `log must not contain ${forbidden}`).not.toContain(forbidden);
  }
  return JSON.parse(logs[0]);
}

test.describe("email-draft-poller pure helpers", () => {
  test("mailbox path resolution walks parentId, including nested paths", async () => {
    const { resolveMailboxId, mailboxPaths } = await loadPoller();
    expect(resolveMailboxId(MAILBOXES, "Create draft/adamdaniel.ai")).toBe("mb-ad");
    expect(resolveMailboxId(MAILBOXES, "Other/adamdaniel.ai")).toBe("mb-other-ad");
    expect(resolveMailboxId(MAILBOXES, "Create draft/adamdaniel.ai/Processed")).toBe("mb-ad-processed");
    expect(resolveMailboxId(MAILBOXES, "/Create draft//adamdaniel.ai/")).toBe("mb-ad");
    expect(resolveMailboxId(MAILBOXES, "adamdaniel.ai")).toBeNull();
    // A parent cycle is dropped, not looped on.
    const cyclic = [
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
    ];
    expect(mailboxPaths(cyclic).size).toBe(0);
  });

  test("parseRoutes rejects malformed ROUTES", async () => {
    const { parseRoutes } = await loadPoller();
    expect(parseRoutes(JSON.stringify(ROUTES))).toEqual(ROUTES);
    for (const bad of ["", "{}", "[]", '[{"mailbox":"x"}]', '[{"mailbox":"","repo":"o/r"}]', '[{"mailbox":"x","repo":"nope"}]']) {
      expect(() => parseRoutes(bad), bad).toThrow();
    }
  });

  test("JWT has RS256 header, iss/iat/exp claims and a verifiable signature", async () => {
    const { buildAppJwt } = await loadPoller();
    const jwt = buildAppJwt("Iv1.fakeclientid", PRIVATE_PEM, NOW);
    const [h, p, s] = jwt.split(".");
    const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    expect(dec(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const now = Math.floor(NOW / 1000);
    expect(dec(p)).toEqual({ iat: now - 60, exp: now + 540, iss: "Iv1.fakeclientid" });
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), other, Buffer.from(s, "base64url"))).toBe(false);
  });

  test("request builders", async () => {
    const m = await loadPoller();
    expect(m.buildEmailQuery("A", "mb")).toEqual([
      "Email/query",
      {
        accountId: "A",
        filter: { inMailbox: "mb", notKeyword: "$cms-dispatched" },
        sort: [{ property: "receivedAt", isAscending: true }],
        limit: 10,
      },
      "q",
    ]);
    expect(m.buildKeywordSet("A", "e1")[1]).toEqual({
      accountId: "A",
      update: { e1: { "keywords/$cms-dispatched": true } },
    });
    expect(m.buildMintBody("adamdaniel.ai")).toEqual({
      repositories: ["adamdaniel.ai"],
      permissions: { contents: "write" },
    });
  });
});

test.describe("email-draft-poller handler", () => {
  test("a new email: installation -> narrowed token -> exact dispatch -> keyword set", async () => {
    const world = fakeWorld();
    const { handler, logs } = await makeHandler(world);
    await handler();
    const gh = world.calls.filter((c) => new URL(c.url).host === "api.github.com");
    expect(gh.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/Adam-S-Daniel/adamdaniel.ai/installation",
      "POST https://api.github.com/app/installations/4242/access_tokens",
      "POST https://api.github.com/repos/Adam-S-Daniel/adamdaniel.ai/dispatches",
    ]);
    expect(gh[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(gh[1].body).toEqual({ repositories: ["adamdaniel.ai"], permissions: { contents: "write" } });
    expect(gh[2].auth).toBe(`Bearer ${INSTALL_TOKEN}`);
    expect(gh[2].body).toEqual({ event_type: "email-draft", client_payload: { email_id: "e1" } });
    const query = world.calls.find((c) => c.body && c.body.methodCalls && c.body.methodCalls[0][0] === "Email/query");
    expect(query.body.methodCalls[0][1].filter).toEqual({ inMailbox: "mb-ad", notKeyword: "$cms-dispatched" });
    expect(world.keyworded).toEqual([{ emailId: "e1", patch: { "keywords/$cms-dispatched": true } }]);
    const summary = expectCleanLogs(logs);
    expect(summary.routes).toEqual([{ route: 0, found: 1, dispatched: 1, failed: 0 }]);
    expect(summary.ok).toBe(true);
  });

  test("dispatch failure: keyword NOT set, handler throws at the end", async () => {
    const world = fakeWorld({ dispatchStatus: 422 });
    const { handler, logs } = await makeHandler(world);
    await expect(handler()).rejects.toThrow(/routes failed/);
    expect(world.keyworded).toEqual([]);
    const summary = expectCleanLogs(logs);
    expect(summary.routes[0]).toMatchObject({ found: 1, dispatched: 0, failed: 1 });
    expect(summary.routes[0].errors).toEqual([{ error: "HttpError", stage: "dispatch", status: 422 }]);
  });

  test("missing mailbox: route errors, other routes still run, handler throws", async () => {
    const world = fakeWorld();
    const routes = [{ mailbox: "Create draft/missing", repo: "Adam-S-Daniel/adamdaniel.ai" }, ...ROUTES];
    const { handler, logs } = await makeHandler(world, routes);
    await expect(handler()).rejects.toThrow();
    const summary = expectCleanLogs(logs);
    expect(summary.routes[0]).toMatchObject({ route: 0, found: 0, dispatched: 0 });
    expect(summary.routes[0].errors).toEqual([{ error: "MailboxNotFoundError", stage: "mailbox" }]);
    expect(summary.routes[1]).toEqual({ route: 1, found: 1, dispatched: 1, failed: 0 });
    expect(world.keyworded.map((k) => k.emailId)).toEqual(["e1"]);
  });

  test("installation token is cached across emails and invocations", async () => {
    const world = fakeWorld({ emails: { "mb-ad": ["e1", "e2"] } });
    const { handler } = await makeHandler(world);
    await handler();
    await handler();
    const count = (re) => world.calls.filter((c) => re.test(c.url)).length;
    expect(count(/\/installation$/)).toBe(1);
    expect(count(/\/access_tokens$/)).toBe(1);
    expect(count(/\/dispatches$/)).toBe(4);
    // The JMAP session is cached across warm invocations too.
    expect(count(/jmap\/session$/)).toBe(1);
  });
});

test.describe("email-draft-poller SAM template", () => {
  function intrinsic(name) {
    const key = `Fn::${name}`;
    return [
      { tag: `!${name}`, resolve: (s) => ({ [key]: s }) },
      { tag: `!${name}`, collection: "seq", resolve: (seq) => ({ [key]: seq.toJSON() }) },
      { tag: `!${name}`, collection: "map", resolve: (map) => ({ [key]: map.toJSON() }) },
    ];
  }
  const CFN_TAGS = [
    { tag: "!Ref", resolve: (s) => ({ Ref: s }) },
    ...["Sub", "If", "GetAtt", "Equals", "Not", "Join", "Select", "Split"].flatMap(intrinsic),
  ];
  const tpl = () =>
    YAML.parse(fs.readFileSync(path.join(DIR, "template.yaml"), "utf8"), { customTags: CFN_TAGS });

  test("one poll at a time, every minute, on nodejs22.x", () => {
    const fn = tpl().Resources.PollerFunction;
    expect(fn.Type).toBe("AWS::Serverless::Function");
    expect(fn.Properties.ReservedConcurrentExecutions).toBe(1);
    expect(fn.Properties.Runtime).toBe("nodejs22.x");
    expect(fn.Properties.Handler).toBe("index.handler");
    const events = Object.values(fn.Properties.Events);
    expect(events).toEqual([expect.objectContaining({ Type: "Schedule" })]);
    expect(events[0].Properties.Schedule).toBe("rate(1 minute)");
  });

  test("IAM grants GetSecretValue on the secret parameters only, never *", () => {
    const t = tpl();
    const statements = t.Resources.PollerFunction.Properties.Policies.flatMap((p) => p.Statement);
    expect(statements).toHaveLength(1);
    const [st] = statements;
    expect(st.Action).toBe("secretsmanager:GetSecretValue");
    const json = JSON.stringify(st.Resource);
    expect(json).not.toContain("*");
    const refs = new Set();
    JSON.stringify(st.Resource, (k, v) => {
      if (k === "Ref") refs.add(v);
      if (k === "Fn::Sub") for (const m of String(v).matchAll(/\$\{([^}]+)\}/g)) refs.add(m[1]);
      return v;
    });
    expect([...refs].sort()).toEqual(["ExtraFastmailTokenSecretArns", "FastmailTokenSecretArn", "GitHubAppSecretArn"]);
    for (const r of refs) expect(t.Parameters[r], r).toBeTruthy();
    expect(st.Resource["Fn::If"][0]).toBe("HasExtraSecrets");
  });
});
