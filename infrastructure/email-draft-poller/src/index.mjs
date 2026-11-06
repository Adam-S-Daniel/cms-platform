// email-draft-poller — polls Fastmail over JMAP (RFC 8620/8621) once a minute
// and fires a GitHub `repository_dispatch` (event_type `email-draft`) at the
// site repo mapped to each mailbox that holds a new message.
//
// Fastmail has no webhooks, so EventBridge invokes this every minute. The
// poller never reads a message's content or addresses: a Fastmail rule files
// each secret posting address into its own mailbox, a route maps that mailbox
// PATH to a repo, and the site's own workflow fetches, validates and processes
// the message, then moves it into a `Processed` or `Failed` child mailbox.
//
// A message is dispatched once: after a 204 from GitHub the poller sets the
// JMAP keyword `$cms-dispatched` on it, and the query skips keyword-bearing
// messages. A failed dispatch leaves the keyword unset, so the next minute
// retries it. (A dispatch that succeeds but whose keyword write fails is sent
// again next minute, so the site workflow must tolerate a repeat.)
//
// Logging: one JSON line per invocation with counts per route INDEX and HTTP
// status codes / error class names. Never a token, a response body, a subject
// or an address.
//
// No npm dependencies: global fetch, node:crypto, and the AWS SDK v3 Secrets
// Manager client that the nodejs22.x Lambda runtime provides.
import crypto from "node:crypto";

export const DISPATCHED_KEYWORD = "$cms-dispatched";
export const EVENT_TYPE = "email-draft";
export const JMAP_SESSION_URL = "https://api.fastmail.com/jmap/session";
export const GITHUB_API = "https://api.github.com";
export const QUERY_LIMIT = 10;
const JMAP_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const SESSION_TTL_MS = 60 * 60 * 1000;
const SECRET_TTL_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

// ── Errors whose class name and fields are safe to log ─────────────────────
export class HttpError extends Error {
  constructor(stage, status) {
    super(`${stage} -> HTTP ${status}`);
    this.name = "HttpError";
    this.stage = stage;
    this.status = status;
  }
}
export class JmapMethodError extends Error {
  constructor(method, type) {
    super(`${method} -> ${type}`);
    this.name = "JmapMethodError";
    this.stage = method;
    // `type` is from RFC 8620's fixed vocabulary (e.g. "invalidArguments").
    this.type = String(type || "unknown").replace(/[^A-Za-z]/g, "").slice(0, 40);
  }
}
export class MailboxNotFoundError extends Error {
  constructor() {
    super("mailbox not found");
    this.name = "MailboxNotFoundError";
    this.stage = "mailbox";
  }
}
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.stage = "config";
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

// ROUTES env JSON -> validated array. Mailbox paths and repo names are not
// secret, but a malformed entry is a deploy fault, so it fails the invocation.
export function parseRoutes(text) {
  let routes;
  try {
    routes = JSON.parse(text || "");
  } catch {
    throw new ConfigError("ROUTES is not valid JSON");
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new ConfigError("ROUTES must be a non-empty JSON array");
  }
  routes.forEach((r, i) => {
    if (!r || typeof r !== "object") throw new ConfigError(`ROUTES[${i}] is not an object`);
    if (typeof r.mailbox !== "string" || !r.mailbox.trim()) {
      throw new ConfigError(`ROUTES[${i}].mailbox must be a non-empty string`);
    }
    if (typeof r.repo !== "string" || !REPO_RE.test(r.repo)) {
      throw new ConfigError(`ROUTES[${i}].repo must be owner/name`);
    }
    if (r.fastmailTokenSecretArn !== undefined && typeof r.fastmailTokenSecretArn !== "string") {
      throw new ConfigError(`ROUTES[${i}].fastmailTokenSecretArn must be a string`);
    }
  });
  return routes;
}

// "a/b//c/" -> "a/b/c": empty segments carry no meaning in a path.
export function normalizeMailboxPath(p) {
  return String(p)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

// Mailbox/get list -> Map(fullPath -> id), the path built by walking parentId.
// A parent cycle or a dangling parentId drops that mailbox rather than looping.
export function mailboxPaths(mailboxes) {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const out = new Map();
  for (const m of mailboxes) {
    const names = [];
    const seen = new Set();
    let cur = m;
    let ok = true;
    while (cur) {
      if (seen.has(cur.id)) {
        ok = false;
        break;
      }
      seen.add(cur.id);
      names.unshift(cur.name);
      if (cur.parentId == null) break;
      cur = byId.get(cur.parentId);
      if (!cur) ok = false;
    }
    if (ok) out.set(normalizeMailboxPath(names.join("/")), m.id);
  }
  return out;
}

export function resolveMailboxId(mailboxes, path) {
  return mailboxPaths(mailboxes).get(normalizeMailboxPath(path)) || null;
}

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// GitHub App JWT: RS256, iss = the App's client id, iat back-dated 60 s for
// clock skew, exp 9 minutes out (GitHub rejects more than 10).
export function buildAppJwt(clientId, privateKey, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

export function buildJmapRequest(methodCalls) {
  return { using: JMAP_USING, methodCalls };
}

export function buildMailboxGet(accountId) {
  return ["Mailbox/get", { accountId, ids: null, properties: ["id", "name", "parentId"] }, "mb"];
}

export function buildEmailQuery(accountId, mailboxId) {
  return [
    "Email/query",
    {
      accountId,
      filter: { inMailbox: mailboxId, notKeyword: DISPATCHED_KEYWORD },
      sort: [{ property: "receivedAt", isAscending: true }],
      limit: QUERY_LIMIT,
    },
    "q",
  ];
}

// JMAP patch syntax: set one keyword without replacing the others.
export function buildKeywordSet(accountId, emailId) {
  return [
    "Email/set",
    { accountId, update: { [emailId]: { [`keywords/${DISPATCHED_KEYWORD}`]: true } } },
    "kw",
  ];
}

// Narrowed to ONE repository and contents: write (what repository_dispatch
// needs). The App installation may hold more; this token cannot.
export function buildMintBody(repoName) {
  return { repositories: [repoName], permissions: { contents: "write" } };
}

export function buildDispatchBody(emailId) {
  return { event_type: EVENT_TYPE, client_payload: { email_id: emailId } };
}

// ── Production secrets getter (lazy, so tests never load the SDK) ─────────
let smClient;
async function getSecretFromSecretsManager(arn) {
  if (!smClient) {
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    smClient = new SecretsManagerClient({});
  }
  const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const out = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
  if (typeof out.SecretString !== "string") throw new ConfigError("secret has no SecretString");
  return out.SecretString;
}

// ── Handler factory ────────────────────────────────────────────────────────
// Every cache lives in this closure; the production `handler` below is built
// once per container, so the caches survive warm invocations.
export function createHandler({
  fetch: fetchImpl = globalThis.fetch,
  getSecret = getSecretFromSecretsManager,
  now = () => Date.now(),
  log = (line) => console.log(line),
  env = process.env,
  jmapSessionUrl = JMAP_SESSION_URL,
  githubApi = GITHUB_API,
} = {}) {
  const secretCache = new Map(); // arn -> { value, at }
  const sessionCache = new Map(); // fastmail secret arn -> { apiUrl, accountId, at }
  const tokenCache = new Map(); // "owner/repo" -> { token, expiresAt }

  async function secret(arn) {
    const hit = secretCache.get(arn);
    if (hit && now() - hit.at < SECRET_TTL_MS) return hit.value;
    const value = await getSecret(arn);
    secretCache.set(arn, { value, at: now() });
    return value;
  }

  function request(url, init) {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  // Status only — NEVER a response body (it can quote mail or a token).
  async function json(stage, res, okStatuses = [200]) {
    if (!okStatuses.includes(res.status)) throw new HttpError(stage, res.status);
    try {
      return await res.json();
    } catch {
      throw new HttpError(stage, res.status);
    }
  }

  async function jmapSession(fastmailArn) {
    const hit = sessionCache.get(fastmailArn);
    if (hit && now() - hit.at < SESSION_TTL_MS) return hit;
    const token = await secret(fastmailArn);
    const res = await request(jmapSessionUrl, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const body = await json("jmap-session", res);
    const accountId = body && body.primaryAccounts && body.primaryAccounts[MAIL_CAPABILITY];
    if (!body || typeof body.apiUrl !== "string" || !accountId) {
      throw new HttpError("jmap-session", res.status);
    }
    const s = { apiUrl: body.apiUrl, accountId, token, at: now() };
    sessionCache.set(fastmailArn, s);
    return s;
  }

  async function jmapCall(fastmailArn, session, call) {
    const res = await request(session.apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(buildJmapRequest([call])),
    });
    if (res.status === 401) {
      // A rotated token: refetch the secret and session next time.
      secretCache.delete(fastmailArn);
      sessionCache.delete(fastmailArn);
    }
    const body = await json(call[0], res);
    const resp = body && Array.isArray(body.methodResponses) && body.methodResponses[0];
    if (!resp) throw new JmapMethodError(call[0], "noResponse");
    if (resp[0] === "error") throw new JmapMethodError(call[0], resp[1] && resp[1].type);
    return resp[1];
  }

  async function githubAppCreds() {
    const raw = await secret(env.GITHUB_APP_SECRET_ARN);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfigError("GitHub App secret is not JSON");
    }
    if (!parsed || !parsed.client_id || !parsed.private_key) {
      throw new ConfigError("GitHub App secret lacks client_id or private_key");
    }
    return parsed;
  }

  const ghHeaders = (auth) => ({
    authorization: `Bearer ${auth}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "cms-platform-email-draft-poller",
  });

  async function installationToken(repo) {
    const hit = tokenCache.get(repo);
    if (hit && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return hit.token;
    const { client_id: clientId, private_key: privateKey } = await githubAppCreds();
    const jwt = buildAppJwt(clientId, privateKey, now());
    const inst = await json(
      "installation",
      await request(`${githubApi}/repos/${repo}/installation`, {
        headers: ghHeaders(jwt),
      }),
    );
    if (!inst || !Number.isInteger(inst.id)) throw new HttpError("installation", 200);
    const minted = await json(
      "access-token",
      await request(`${githubApi}/app/installations/${inst.id}/access_tokens`, {
        method: "POST",
        headers: { ...ghHeaders(jwt), "content-type": "application/json" },
        body: JSON.stringify(buildMintBody(repo.split("/")[1])),
      }),
      [201],
    );
    if (!minted || typeof minted.token !== "string") throw new HttpError("access-token", 201);
    const parsedExpiry = Date.parse(minted.expires_at);
    // GitHub's tokens live one hour; assume that if expires_at is unreadable.
    const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + 60 * 60 * 1000;
    tokenCache.set(repo, { token: minted.token, expiresAt });
    return minted.token;
  }

  async function dispatch(repo, emailId) {
    const token = await installationToken(repo);
    const res = await request(`${githubApi}/repos/${repo}/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(buildDispatchBody(emailId)),
    });
    if (res.status === 401) tokenCache.delete(repo);
    if (res.status !== 204) throw new HttpError("dispatch", res.status);
  }

  const errorRecord = (err) => {
    const rec = { error: err && err.name ? String(err.name).slice(0, 40) : "Error" };
    if (err && typeof err.stage === "string") rec.stage = err.stage;
    if (err && Number.isInteger(err.status)) rec.status = err.status;
    if (err && typeof err.type === "string") rec.type = err.type;
    return rec;
  };

  return async function handler() {
    const summary = { poller: "email-draft", routes: [] };
    let failed = false;
    try {
      const routes = parseRoutes(env.ROUTES);
      const mailboxesByArn = new Map(); // one Mailbox/get per account per invocation

      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        const rec = { route: i, found: 0, dispatched: 0, failed: 0, errors: [] };
        summary.routes.push(rec);
        try {
          const arn = route.fastmailTokenSecretArn || env.FASTMAIL_TOKEN_SECRET_ARN;
          if (!arn) throw new ConfigError("no Fastmail token secret ARN");
          const session = await jmapSession(arn);
          if (!mailboxesByArn.has(arn)) {
            const got = await jmapCall(arn, session, buildMailboxGet(session.accountId));
            mailboxesByArn.set(arn, (got && got.list) || []);
          }
          const mailboxId = resolveMailboxId(mailboxesByArn.get(arn), route.mailbox);
          if (!mailboxId) throw new MailboxNotFoundError();
          const q = await jmapCall(arn, session, buildEmailQuery(session.accountId, mailboxId));
          const ids = (q && Array.isArray(q.ids) ? q.ids : []).filter((x) => typeof x === "string");
          rec.found = ids.length;

          for (const emailId of ids) {
            try {
              await dispatch(route.repo, emailId);
            } catch (err) {
              rec.failed++;
              rec.errors.push(errorRecord(err));
              continue; // keyword NOT set: retried next minute
            }
            rec.dispatched++;
            try {
              const set = await jmapCall(arn, session, buildKeywordSet(session.accountId, emailId));
              if (!set || !set.updated || !(emailId in set.updated)) {
                throw new JmapMethodError("Email/set", "notUpdated");
              }
            } catch (err) {
              rec.errors.push(errorRecord(err));
            }
          }
        } catch (err) {
          rec.errors.push(errorRecord(err));
        }
        if (rec.errors.length || rec.failed) failed = true;
        if (!rec.errors.length) delete rec.errors;
      }
    } catch (err) {
      summary.error = errorRecord(err);
      failed = true;
    }
    summary.ok = !failed;
    log(JSON.stringify(summary));
    // Throwing marks the invocation failed, so the Errors alarm fires.
    if (failed) throw new Error("email-draft-poller: one or more routes failed (see summary log)");
    return summary;
  };
}

export const handler = createHandler();
