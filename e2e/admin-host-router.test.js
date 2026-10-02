// @lane: local — pure-Node: parses the bootstrap template with the real `yaml`
// package and runs AdminHostRouterFunction's code in Node; no network.
//
// cms-platform#517 — the opt-in admin origin. The editor keeps GitHub tokens
// in localStorage, readable by every script on its origin, so with
// AdminDomainName set:
//   (a) the admin host serves only /admin/ (plus HEAD probes), and sends every
//       other path to the apex — an admin origin that could render a public
//       page would put that page's scripts right back next to the token;
//   (b) /admin on the apex or www goes to the admin host, path and query kept;
//   (c) with AdminDomainName empty the stack is what it was before #517: no
//       function, no alias, no SAN, no DNS record, no association.
// The function body is read out of the template (the single source of truth)
// and `Fn::Sub` is simulated with a synthetic example.test apex, as the
// cloudfront-preview-*.spec.js siblings do.
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
  return /Admin(DomainName|HostRouterFunction)/.test(JSON.stringify(value));
}

function loadHandler(template) {
  const code = template.Resources.AdminHostRouterFunction.Properties.FunctionCode;
  expect(Object.keys(code), "FunctionCode is a !Sub so the hosts are baked in").toEqual(["Fn::Sub"]);
  const src = code["Fn::Sub"]
    .replace(/\$\{AdminDomainName\}/g, ADMIN)
    .replace(/\$\{ProductionDomainName\}/g, APEX);
  expect(src, "no other ${...} may remain for Fn::Sub to choke on").not.toContain("${");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn handler;`)();
}

// A CloudFront Functions viewer-request event. `query` maps a name to one
// value or an array (the multiValue shape).
function event(host, uri, { method = "GET", query = {} } = {}) {
  const querystring = {};
  for (const [name, v] of Object.entries(query)) {
    const values = Array.isArray(v) ? v : [v];
    querystring[name] = { value: values[0] };
    if (values.length > 1) querystring[name].multiValue = values.map((value) => ({ value }));
  }
  return {
    request: {
      method,
      uri,
      querystring,
      headers: host ? { host: { value: host } } : {},
    },
  };
}

function location(result) {
  expect(result.statusCode, "expected a redirect").toBe(302);
  return result.headers.location.value;
}

test.describe("AdminHostRouterFunction behavior (#517)", () => {
  const handler = loadHandler(loadTemplate());

  test("(a) the admin host serves /admin, /admin/ and everything under it unchanged", () => {
    for (const uri of ["/admin", "/admin/", "/admin/reviews/", "/admin/config.yml"]) {
      const evt = event(ADMIN, uri);
      expect(handler(evt), uri).toBe(evt.request);
      expect(evt.request.uri, uri).toBe(uri);
    }
  });

  test("(a) any other admin-host path goes to the same path on the apex", () => {
    expect(location(handler(event(ADMIN, "/blog/foo/")))).toBe(`https://${APEX}/blog/foo/`);
    expect(location(handler(event(ADMIN, "/404.html")))).toBe(`https://${APEX}/404.html`);
    expect(
      location(handler(event(ADMIN, "/preview/", { query: { collection: "posts" } }))),
      "/preview/ is a public page (RUM, an unhashed marked.js from unpkg) and stays off the admin origin",
    ).toBe(`https://${APEX}/preview/?collection=posts`);
  });

  test("(a) a path that merely starts with 'admin' is not the admin", () => {
    expect(location(handler(event(ADMIN, "/administrator/")))).toBe(`https://${APEX}/administrator/`);
    expect(location(handler(event(ADMIN, "/admin.html")))).toBe(`https://${APEX}/admin.html`);
  });

  test("(a) the admin host root opens the editor", () => {
    expect(location(handler(event(ADMIN, "/")))).toBe(`https://${ADMIN}/admin/`);
  });

  test("(a) a HEAD on any admin-host path is served (no body runs; slug-pin.js probes with it)", () => {
    const evt = event(ADMIN, "/blog/foo/", { method: "HEAD" });
    expect(handler(evt)).toBe(evt.request);
  });

  test("(a) the Host header is matched case-insensitively", () => {
    expect(location(handler(event("ADMIN.Example.TEST", "/blog/")))).toBe(`https://${APEX}/blog/`);
  });

  for (const host of [APEX, `www.${APEX}`]) {
    test(`(b) /admin on ${host} goes to the admin host, path and query kept`, () => {
      expect(location(handler(event(host, "/admin")))).toBe(`https://${ADMIN}/admin`);
      expect(location(handler(event(host, "/admin/")))).toBe(`https://${ADMIN}/admin/`);
      expect(location(handler(event(host, "/admin/reviews/health.html", { query: { pr: "12" } })))).toBe(
        `https://${ADMIN}/admin/reviews/health.html?pr=12`,
      );
    });

    test(`(b) every other path on ${host} is untouched`, () => {
      for (const uri of ["/", "/blog/foo/", "/preview/", "/administrator/"]) {
        const evt = event(host, uri);
        expect(handler(evt), uri).toBe(evt.request);
        expect(evt.request.uri, uri).toBe(uri);
      }
    });
  }

  test("(b) repeated and valueless query parameters survive the redirect", () => {
    const result = handler(event(APEX, "/admin/", { query: { a: ["1", "2"], debug: "" } }));
    expect(location(result)).toBe(`https://${ADMIN}/admin/?a=1&a=2&debug`);
  });

  test("a request with no Host header is left alone unless it asks for /admin", () => {
    const evt = event("", "/blog/");
    expect(handler(evt)).toBe(evt.request);
    expect(location(handler(event("", "/admin/")))).toBe(`https://${ADMIN}/admin/`);
  });
});

test.describe("bootstrap template wiring for the admin host (#517)", () => {
  const template = loadTemplate();

  test("AdminDomainName is an optional parameter that defaults to off", () => {
    const param = template.Parameters.AdminDomainName;
    expect(param.Type).toBe("String");
    expect(param.Default).toBe("");
    expect(template.Conditions.HasAdminDomain).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "AdminDomainName" }, ""] }],
    });
  });

  test("the function, the DNS record and the output exist only when the host is set", () => {
    for (const name of ["AdminHostRouterFunction", "AdminDnsRecord"]) {
      expect(template.Resources[name].Condition, name).toBe("HasAdminDomain");
    }
    expect(template.Outputs.AdminURL.Condition).toBe("HasAdminDomain");
  });

  test("(c) with AdminDomainName empty nothing deployed mentions the admin host", () => {
    const off = deployedAs(template, false);
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
    const cert = off.Resources.ProductionCertificate.Properties;
    expect(cert.SubjectAlternativeNames).toEqual([{ "Fn::Sub": "www.${ProductionDomainName}" }]);
    expect(cert.DomainValidationOptions).toHaveLength(2);
  });

  test("with AdminDomainName set, the production distribution, certificate and DNS answer for it", () => {
    const on = deployedAs(template, true);
    const dist = on.Resources.ProductionDistribution.Properties.DistributionConfig;
    expect(dist.Aliases).toContainEqual({ Ref: "AdminDomainName" });
    expect(dist.DefaultCacheBehavior.FunctionAssociations).toEqual([
      {
        EventType: "viewer-request",
        FunctionARN: { "Fn::GetAtt": ["AdminHostRouterFunction", "FunctionARN"] },
      },
    ]);
    const cert = on.Resources.ProductionCertificate.Properties;
    expect(cert.SubjectAlternativeNames).toContainEqual({ Ref: "AdminDomainName" });
    expect(cert.DomainValidationOptions).toContainEqual({
      DomainName: { Ref: "AdminDomainName" },
      HostedZoneId: { Ref: "HostedZoneId" },
    });
    const dns = on.Resources.AdminDnsRecord.Properties;
    expect(dns.Name).toEqual({ Ref: "AdminDomainName" });
    expect(dns.AliasTarget.DNSName).toEqual({
      "Fn::GetAtt": ["ProductionDistribution", "DomainName"],
    });
    expect(on.Resources.AdminHostRouterFunction.Properties.FunctionConfig.Runtime).toBe(
      "cloudfront-js-2.0",
    );
  });

  test("the preview distribution is untouched: preview admins stay on their own hosts", () => {
    const on = deployedAs(template, true);
    expect(mentionsAdmin(on.Resources.PreviewDistribution)).toBe(false);
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
