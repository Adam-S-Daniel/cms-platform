// @lane: local — pure-Node: parses the bootstrap template with the real `yaml`
// package and runs the admin-origin CloudFront Functions' code in Node; no
// network.
//
// cms-platform#517 — the opt-in admin origin. The editor keeps GitHub tokens
// in localStorage, readable by every script on its origin, so with
// AdminDomainName set:
//   (a) AdminDistribution, a distribution of its own, serves only /admin/ out
//       of the production bucket's REST endpoint, answers a miss with a
//       script-free page, and sends every other GET to the apex. It must never
//       return a document that runs a public page's script: as an alias on the
//       production distribution, a missing /admin/<x> got the public
//       /404.html (RUM included) on the admin origin, because a distribution's
//       custom error responses cannot vary by host;
//   (b) /admin on the apex or www goes to the admin host, path and query kept;
//   (c) with AdminDomainName empty the stack is what it was before #517: no
//       admin resource, no association, no change to the production
//       distribution or certificate.
// Function bodies are read out of the template (the single source of truth)
// and `Fn::Sub` is simulated with a synthetic example.test apex, as the
// cloudfront-preview-*.spec.js siblings do. The script-free page itself is
// parsed and checked by theme/spec/admin_not_found_page_test.rb.
//
// Parsing: `YAML.parseDocument` keeps CloudFormation's short-form tags (`!If`,
// `!Ref`, `!Sub`, …) on the nodes even though it cannot resolve them, so
// `toCfn` below turns each tagged node into its long form ({"Fn::If": …}).
// That keeps the condition wiring assertable instead of silently dropped.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const TEMPLATE_PATH = path.join(__dirname, "..", "infrastructure/bootstrap/template.yaml");
const ADMIN_SRC = path.join(__dirname, "..", "theme", "admin");
const APEX = "example.test";
const ADMIN = "admin.example.test";
const ADMIN_RESOURCES = [
  "AdminCertificate",
  "AdminSiteFunction",
  "ApexAdminRedirectFunction",
  "AdminDistribution",
  "AdminDnsRecord",
];

function toCfn(node) {
  let value;
  if (YAML.isMap(node)) {
    value = {};
    for (const pair of node.items) value[String(pair.key.value)] = toCfn(pair.value);
  } else if (YAML.isSeq(node)) {
    value = node.items.map(toCfn);
  } else if (YAML.isScalar(node)) {
    value = node.value;
  } else {
    value = node == null ? null : node;
  }
  if (node && typeof node.tag === "string" && node.tag.startsWith("!")) {
    const name = node.tag.slice(1);
    if (name === "GetAtt" && typeof value === "string") value = value.split(".");
    return { [name === "Ref" ? "Ref" : `Fn::${name}`]: value };
  }
  return value;
}

function loadTemplate() {
  const doc = YAML.parseDocument(fs.readFileSync(TEMPLATE_PATH, "utf8"), { logLevel: "silent" });
  expect(doc.errors, "template.yaml must parse").toEqual([]);
  return toCfn(doc.contents);
}

const NO_VALUE = Symbol("AWS::NoValue");

// Resolve every Fn::If against `conditions` and drop AWS::NoValue the way
// CloudFormation does (from lists and as a property value). Other intrinsics
// are left as data.
function resolveConditions(value, conditions) {
  if (Array.isArray(value)) {
    return value.map((v) => resolveConditions(v, conditions)).filter((v) => v !== NO_VALUE);
  }
  if (value && typeof value === "object") {
    if (value.Ref === "AWS::NoValue") return NO_VALUE;
    if (Array.isArray(value["Fn::If"])) {
      const [name, whenTrue, whenFalse] = value["Fn::If"];
      if (!(name in conditions)) throw new Error(`unknown condition ${name}`);
      return resolveConditions(conditions[name] ? whenTrue : whenFalse, conditions);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveConditions(v, conditions);
      if (r !== NO_VALUE) out[k] = r;
    }
    return out;
  }
  return value;
}

// The template as deployed with AdminDomainName set (true) or empty (false):
// resources gated on HasAdminDomain are dropped when it is false.
function deployedAs(template, hasAdmin) {
  const conditions = {
    HasAdminDomain: hasAdmin,
    ShouldCreateOIDCProvider: true,
    ShouldCreateApexDnsRecords: true,
    ShouldCreateMediaArchive: true,
    // #515's header conditions, at their parameter defaults.
    HstsIncludesSubdomains: false,
    HstsPreloads: false,
    AdminCspEnforced: false,
  };
  const resources = {};
  for (const [name, res] of Object.entries(template.Resources)) {
    if (res.Condition === "HasAdminDomain" && !hasAdmin) continue;
    resources[name] = resolveConditions(res, conditions);
  }
  const outputs = {};
  for (const [name, out] of Object.entries(template.Outputs)) {
    if (out.Condition === "HasAdminDomain" && !hasAdmin) continue;
    outputs[name] = resolveConditions(out, conditions);
  }
  return { Resources: resources, Outputs: outputs };
}

function mentionsAdmin(value) {
  return /Admin(DomainName|Certificate|SiteFunction|RedirectFunction|Distribution|DnsRecord)/.test(
    JSON.stringify(value),
  );
}

function loadHandler(template, name) {
  const code = template.Resources[name].Properties.FunctionCode;
  expect(Object.keys(code), "FunctionCode is a !Sub so the hosts are baked in").toEqual(["Fn::Sub"]);
  const src = code["Fn::Sub"]
    .replace(/\$\{AdminDomainName\}/g, ADMIN)
    .replace(/\$\{ProductionDomainName\}/g, APEX);
  expect(src, "no other ${...} may remain for Fn::Sub to choke on").not.toContain("${");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn handler;`)();
}

// A CloudFront Functions viewer-request event. `query` maps a name to one
// value or an array (the multiValue shape). The URI is passed through as
// given: CloudFront normalizes a path only to pick a cache behavior and sends
// the raw path on, so the functions must not assume a clean one.
function event(uri, { method = "GET", query = {}, host = ADMIN } = {}) {
  const querystring = {};
  for (const [name, v] of Object.entries(query)) {
    const values = Array.isArray(v) ? v : [v];
    querystring[name] = { value: values[0] };
    if (values.length > 1) querystring[name].multiValue = values.map((value) => ({ value }));
  }
  return { request: { method, uri, querystring, headers: { host: { value: host } } } };
}

function location(result) {
  expect(result.statusCode, "expected a redirect").toBe(302);
  return result.headers.location.value;
}

// What reaches the bucket: the request object, with the URI S3 will look up.
function served(result, evt) {
  expect(result, "expected the request to go on to the origin").toBe(evt.request);
  return result.uri;
}

// An S3 key under admin/ with no dot segment, %-escape, empty segment or odd
// character: the only shape AdminSiteFunction may send to the origin on GET.
const CLEAN_ADMIN_KEY = /^\/admin\/([A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

test.describe("AdminSiteFunction: the admin distribution (#517)", () => {
  const site = loadHandler(loadTemplate(), "AdminSiteFunction");

  test("(a) /admin/ files are served, and a trailing / maps to its index.html (the REST origin has no index document)", () => {
    const cases = {
      "/admin/": "/admin/index.html",
      "/admin/reviews/": "/admin/reviews/index.html",
      "/admin/reviews/health.html": "/admin/reviews/health.html",
      "/admin/config.yml": "/admin/config.yml",
      "/admin/decap-cms-shim.v2.js": "/admin/decap-cms-shim.v2.js",
      "/admin/not-found.html": "/admin/not-found.html",
    };
    for (const [uri, key] of Object.entries(cases)) {
      const evt = event(uri);
      expect(served(site(evt), evt), uri).toBe(key);
    }
  });

  test("(a) every file the gem ships under admin/ passes the clean-key check", () => {
    const shipped = [
      ...fs.readdirSync(ADMIN_SRC).filter((f) => fs.statSync(path.join(ADMIN_SRC, f)).isFile()),
      ...fs.readdirSync(path.join(ADMIN_SRC, "reviews")).map((f) => `reviews/${f}`),
    ];
    for (const file of shipped) {
      const evt = event(`/admin/${file}`);
      expect(served(site(evt), evt), file).toBe(`/admin/${file}`);
    }
  });

  test("(a) an extensionless /admin path gets a 302 to its slash form, query kept, as the website endpoint did", () => {
    expect(location(site(event("/admin")))).toBe(`https://${ADMIN}/admin/`);
    expect(location(site(event("/admin/reviews", { query: { pr: "12" } })))).toBe(
      `https://${ADMIN}/admin/reviews/?pr=12`,
    );
  });

  test("(a) a GET anywhere else goes to the same path and query on the apex, never to the origin", () => {
    const cases = {
      "/blog/foo/": `https://${APEX}/blog/foo/`,
      "/404.html": `https://${APEX}/404.html`,
      "/index.html": `https://${APEX}/index.html`,
      "/administrator/": `https://${APEX}/administrator/`,
      "/admin.html": `https://${APEX}/admin.html`,
      "/adminx/index.html": `https://${APEX}/adminx/index.html`,
      // S3 keys are case-sensitive, so these are not the editor: on the apex
      // they are ordinary misses.
      "/Admin/": `https://${APEX}/Admin/`,
      "/ADMIN/index.html": `https://${APEX}/ADMIN/index.html`,
      // An encoded separator right after "admin" is not "/admin/".
      "/admin%2f..%2f404.html": `https://${APEX}/admin%2f..%2f404.html`,
      "/admin%2Findex.html": `https://${APEX}/admin%2Findex.html`,
    };
    for (const [uri, target] of Object.entries(cases)) expect(location(site(event(uri))), uri).toBe(target);
    expect(
      location(site(event("/preview/", { query: { collection: "posts" } }))),
      "/preview/ is a public page (RUM, an unhashed marked.js from unpkg) and stays off the admin origin",
    ).toBe(`https://${APEX}/preview/?collection=posts`);
  });

  test("(a) the admin host root opens the editor", () => {
    expect(location(site(event("/")))).toBe(`https://${ADMIN}/admin/`);
  });

  test("(a) a path under /admin/ that is not a clean key is a bare 404: it reaches neither S3 nor the apex", () => {
    for (const uri of [
      "/admin/../404.html",
      "/admin/./index.html",
      "/admin/reviews/..",
      "/admin/reviews/../../404.html",
      "/admin//index.html",
      "/admin/reviews//",
      "/admin/%2e%2e/404.html",
      "/admin/x%2f..%2f..%2f404.html",
      "/admin/.hidden",
      "/admin/a\\b.html",
      "/admin/café.html",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const result = site(event(uri, { method }));
        expect(result, `${method} ${uri}`).toEqual({ statusCode: 404, statusDescription: "Not Found" });
      }
    }
  });

  test("(a) a HEAD outside /admin/ is served with the same index mapping (slug-pin.js probes /blog/<slug>/ same-origin)", () => {
    let evt = event("/blog/foo/", { method: "HEAD" });
    expect(served(site(evt), evt)).toBe("/blog/foo/index.html");
    evt = event("/blog/caf%C3%A9/", { method: "HEAD" });
    expect(served(site(evt), evt), "slug-pin encodes the slug").toBe("/blog/caf%C3%A9/index.html");
    evt = event("/feed.xml", { method: "HEAD" });
    expect(served(site(evt), evt)).toBe("/feed.xml");
  });

  test("(a) the host is not consulted: every host reaching this distribution gets the same answer", () => {
    for (const host of [ADMIN, `${ADMIN}.`, "ADMIN.Example.TEST", "d111111abcdef8.cloudfront.net"]) {
      expect(location(site(event("/blog/", { host }))), host).toBe(`https://${APEX}/blog/`);
      const evt = event("/admin/", { host });
      expect(served(site(evt), evt), host).toBe("/admin/index.html");
    }
  });

  test("(a) every GET that reaches the origin names a clean admin/ key", () => {
    const corpus = [
      "/", "/admin", "/admin/", "/admin/reviews", "/admin/reviews/", "/admin/index.html",
      "/admin/../404.html", "/admin//", "/admin/%2e%2e/", "/admin/.x", "/blog/", "/404.html",
      "/Admin/", "/admin%2f", "/admin/a/b/c.js", "/admin/a.b/", "/admin/-x/", "/admin/_y.css",
    ];
    for (const uri of corpus) {
      const evt = event(uri);
      const result = site(evt);
      if (result === evt.request) expect(result.uri, uri).toMatch(CLEAN_ADMIN_KEY);
    }
  });
});

test.describe("ApexAdminRedirectFunction: the production distribution (#517)", () => {
  const redirect = loadHandler(loadTemplate(), "ApexAdminRedirectFunction");

  for (const host of [APEX, `www.${APEX}`]) {
    test(`(b) /admin on ${host} goes to the admin host, path and query kept`, () => {
      expect(location(redirect(event("/admin", { host })))).toBe(`https://${ADMIN}/admin`);
      expect(location(redirect(event("/admin/", { host })))).toBe(`https://${ADMIN}/admin/`);
      expect(
        location(redirect(event("/admin/reviews/health.html", { host, query: { pr: "12" } }))),
      ).toBe(`https://${ADMIN}/admin/reviews/health.html?pr=12`);
    });

    test(`(b) every other path on ${host} is untouched`, () => {
      for (const uri of ["/", "/blog/foo/", "/preview/", "/administrator/", "/admin.html", "/404.html"]) {
        const evt = event(uri, { host });
        expect(redirect(evt), uri).toBe(evt.request);
        expect(evt.request.uri, uri).toBe(uri);
      }
    });
  }

  test("(b) repeated and valueless query parameters survive the redirect", () => {
    const result = redirect(event("/admin/", { host: APEX, query: { a: ["1", "2"], debug: "" } }));
    expect(location(result)).toBe(`https://${ADMIN}/admin/?a=1&a=2&debug`);
  });

  test("the two functions never bounce a request between the hosts", () => {
    const site = loadHandler(loadTemplate(), "AdminSiteFunction");
    const corpus = [
      "/", "/admin", "/admin/", "/admin/reviews", "/admin/x.js", "/admin/../404.html", "/admin//",
      "/admin/%2e%2e/", "/Admin/", "/admin%2f..%2f404.html", "/administrator", "/blog/", "/404.html",
    ];
    for (const start of [APEX, ADMIN]) {
      for (const uri of corpus) {
        let host = start;
        let current = uri;
        let hops = 0;
        for (;;) {
          const fn = host === ADMIN ? site : redirect;
          const evt = event(current, { host });
          const result = fn(evt);
          if (result.statusCode !== 302) break;
          const next = new URL(result.headers.location.value);
          host = next.host;
          current = next.pathname;
          hops += 1;
          expect(hops, `${start}${uri} keeps redirecting`).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

test.describe("bootstrap template wiring for the admin origin (#517)", () => {
  const template = loadTemplate();

  test("AdminDomainName is an optional parameter that defaults to off", () => {
    const param = template.Parameters.AdminDomainName;
    expect(param.Type).toBe("String");
    expect(param.Default).toBe("");
    expect(template.Conditions.HasAdminDomain).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "AdminDomainName" }, ""] }],
    });
  });

  test("every admin resource and output exists only when the host is set", () => {
    for (const name of ADMIN_RESOURCES) {
      expect(template.Resources[name], name).toBeDefined();
      expect(template.Resources[name].Condition, name).toBe("HasAdminDomain");
    }
    expect(template.Outputs.AdminURL.Condition).toBe("HasAdminDomain");
  });

  test("(c) with AdminDomainName empty nothing deployed mentions the admin host", () => {
    const off = deployedAs(template, false);
    for (const name of ADMIN_RESOURCES) expect(off.Resources[name], name).toBeUndefined();
    for (const [name, res] of Object.entries(off.Resources)) {
      expect(mentionsAdmin(res), `${name} must be what it was before #517 when the host is unset`).toBe(false);
    }
    for (const [name, out] of Object.entries(off.Outputs)) {
      expect(mentionsAdmin(out), `output ${name}`).toBe(false);
    }
    const dist = off.Resources.ProductionDistribution.Properties.DistributionConfig;
    expect(dist.Aliases).toEqual([
      { Ref: "ProductionDomainName" },
      { "Fn::Sub": "www.${ProductionDomainName}" },
    ]);
    expect(dist.DefaultCacheBehavior).not.toHaveProperty("FunctionAssociations");
  });

  test("opting in changes the production distribution only by the redirect, and never its certificate", () => {
    const off = deployedAs(template, false).Resources;
    const on = deployedAs(template, true).Resources;
    expect(on.ProductionCertificate, "a new SAN would replace the live certificate").toEqual(off.ProductionCertificate);
    expect(on.ProductionCertificate.Properties.SubjectAlternativeNames).toEqual([
      { "Fn::Sub": "www.${ProductionDomainName}" },
    ]);

    const onDist = structuredClone(on.ProductionDistribution.Properties.DistributionConfig);
    const offDist = off.ProductionDistribution.Properties.DistributionConfig;
    expect(onDist.Aliases, "the admin host is NOT an alias here").toEqual(offDist.Aliases);
    // Every behavior on the production distribution (the default and any
    // path behavior, such as #546's /admin/*) must redirect, or the apex
    // keeps serving the editor on the paths that behavior matches.
    const redirectAssoc = [
      {
        EventType: "viewer-request",
        FunctionARN: { "Fn::GetAtt": ["ApexAdminRedirectFunction", "FunctionARN"] },
      },
    ];
    for (const behavior of [onDist.DefaultCacheBehavior, ...(onDist.CacheBehaviors || [])]) {
      expect(behavior.FunctionAssociations, behavior.PathPattern || "default").toEqual(redirectAssoc);
      delete behavior.FunctionAssociations;
    }
    for (const behavior of [offDist.DefaultCacheBehavior, ...(offDist.CacheBehaviors || [])]) {
      expect(behavior.FunctionAssociations, behavior.PathPattern || "default").toBeUndefined();
    }
    expect(onDist, "nothing else on the production distribution changes").toEqual(offDist);
  });

  test("(a) the admin distribution has its own alias and certificate, DNS-validated in the zone", () => {
    const on = deployedAs(template, true).Resources;
    const cert = on.AdminCertificate.Properties;
    expect(cert.DomainName).toEqual({ Ref: "AdminDomainName" });
    expect(cert.ValidationMethod).toBe("DNS");
    expect(cert.DomainValidationOptions).toEqual([
      { DomainName: { Ref: "AdminDomainName" }, HostedZoneId: { Ref: "HostedZoneId" } },
    ]);
    expect(cert).not.toHaveProperty("SubjectAlternativeNames");
    const dist = on.AdminDistribution.Properties.DistributionConfig;
    expect(dist.Aliases).toEqual([{ Ref: "AdminDomainName" }]);
    expect(dist.ViewerCertificate.AcmCertificateArn).toEqual({ Ref: "AdminCertificate" });
    const dns = on.AdminDnsRecord.Properties;
    expect(dns.Name).toEqual({ Ref: "AdminDomainName" });
    expect(dns.Type).toBe("A");
    expect(dns.AliasTarget.DNSName).toEqual({ "Fn::GetAtt": ["AdminDistribution", "DomainName"] });
  });

  test("(a) the admin distribution reads the bucket's REST endpoint, never the website endpoint", () => {
    const dist = deployedAs(template, true).Resources.AdminDistribution.Properties.DistributionConfig;
    expect(dist.Origins).toHaveLength(1);
    const [origin] = dist.Origins;
    expect(origin.DomainName).toEqual({ "Fn::GetAtt": ["ProductionBucket", "RegionalDomainName"] });
    expect(origin).toHaveProperty("S3OriginConfig");
    expect(origin, "a custom origin is how the website endpoint is wired").not.toHaveProperty("CustomOriginConfig");
    expect(JSON.stringify(dist)).not.toContain("s3-website");
    expect(dist, "the function maps / itself; nothing else may pick an object").not.toHaveProperty("DefaultRootObject");
  });

  test("(a) one behavior, guarded by AdminSiteFunction, GET/HEAD only, nothing cached, no query string to S3", () => {
    const dist = deployedAs(template, true).Resources.AdminDistribution.Properties.DistributionConfig;
    expect(dist, "a path behavior would be one the function does not guard").not.toHaveProperty("CacheBehaviors");
    const b = dist.DefaultCacheBehavior;
    expect(b.TargetOriginId).toBe(dist.Origins[0].Id);
    expect(b.FunctionAssociations).toEqual([
      { EventType: "viewer-request", FunctionARN: { "Fn::GetAtt": ["AdminSiteFunction", "FunctionARN"] } },
    ]);
    expect(b.AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(b.CachePolicyId, "CachingDisabled: the deploy invalidates only the production distribution").toBe(
      "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    );
    expect(b).not.toHaveProperty("OriginRequestPolicyId");
    expect(b.ViewerProtocolPolicy).toBe("redirect-to-https");
  });

  test("(a) the admin host sends the same admin headers policy as the apex's /admin/* (frame-ancestors, CSP)", () => {
    const on = deployedAs(template, true).Resources;
    const adminBehavior = on.AdminDistribution.Properties.DistributionConfig.DefaultCacheBehavior;
    const apexAdmin = (on.ProductionDistribution.Properties.DistributionConfig.CacheBehaviors || []).find(
      (b) => b.PathPattern === "/admin/*",
    );
    expect(adminBehavior.ResponseHeadersPolicyId).toEqual({ Ref: "AdminResponseHeadersPolicy" });
    expect(apexAdmin, "the apex /admin/* behavior #515 added").toBeDefined();
    expect(adminBehavior.ResponseHeadersPolicyId).toEqual(apexAdmin.ResponseHeadersPolicyId);
  });

  test("(a) 403 and 404 are answered with the gem's script-free page, as a 404", () => {
    const dist = deployedAs(template, true).Resources.AdminDistribution.Properties.DistributionConfig;
    const byCode = Object.fromEntries(dist.CustomErrorResponses.map((r) => [r.ErrorCode, r]));
    expect(Object.keys(byCode).sort()).toEqual(["403", "404"]);
    for (const code of [403, 404]) {
      expect(byCode[code], String(code)).toEqual({
        ErrorCode: code,
        ResponseCode: 404,
        ResponsePagePath: "/admin/not-found.html",
        ErrorCachingMinTTL: 0,
      });
    }
    expect(fs.existsSync(path.join(ADMIN_SRC, "not-found.html")), "the page ships in the gem").toBe(true);
  });

  test("the preview distribution is untouched: preview admins stay on their own hosts", () => {
    const on = deployedAs(template, true);
    expect(mentionsAdmin(on.Resources.PreviewDistribution)).toBe(false);
    expect(mentionsAdmin(on.Resources.PreviewDnsRecord)).toBe(false);
  });
});

test.describe("the admin shells load no public-page script (#517)", () => {
  // The admin origin is only worth having if nothing on it is a script the
  // public site also loads. Every external <script src> in the shells must be
  // the SRI-pinned Decap bundle (admin-pin-invariant.test.js checks the hash);
  // nothing may pull the RUM client or a Liquid include, which these raw
  // files would not render anyway.
  const shells = [
    "index.html",
    "index-local.html",
    "index-test.html",
    ...fs.readdirSync(path.join(ADMIN_SRC, "reviews")).filter((f) => f.endsWith(".html")).map((f) => `reviews/${f}`),
  ];
  for (const shell of shells) {
    test(`${shell}: only the Decap bundle comes from off-origin, and no analytics`, () => {
      const html = fs.readFileSync(path.join(ADMIN_SRC, shell), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      const external = [...html.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]*)"/g)].map((m) => m[1]);
      for (const src of external) {
        expect(src, `${shell} loads an off-origin script`).toMatch(/^https:\/\/unpkg\.com\/decap-cms@[0-9.]+\/dist\/decap-cms\.js$/);
      }
      expect(html).not.toContain("cloudwatch-rum");
      expect(html).not.toContain("client.rum.");
      expect(html).not.toContain("{% include");
    });
  }
});
