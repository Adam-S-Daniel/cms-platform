// @lane: local — pure-fs lint, parses the CloudFormation template with the
// real `yaml` package (never a regex over source); no network, no browser.
//
// cms-platform#515 — both CloudFront distributions in
// infrastructure/bootstrap/template.yaml attach response headers policies:
// a baseline on the default behavior, and an /admin/* behavior whose policy
// repeats the baseline and adds the admin Content-Security-Policy, sent as
// Report-Only until AdminCspMode is flipped to `enforce`.
//
// cms-platform#1067 — the baseline carries the PUBLIC Content-Security-Policy
// (a page loads nothing from another host), Report-Only until PublicCspMode is
// `enforce`, and /assets/tools/* (a site's embedded tool apps) gets its own
// policy, which is the public one unless the site sets ToolAppsCsp.
//
// cms-platform#789 — the preview distribution also routes /regression.json
// to its own behavior, whose policy repeats the baseline and adds a CorsConfig
// so /admin/reviews can fetch it cross-origin (see the last describe block).
//
// Unlike preview-custom-error-response.test.js, the values asserted here ARE
// wrapped in intrinsics (`!If`, `!Sub`, `!Ref`), so the parse keeps them as
// their long forms (`{ "Fn::If": [...] }`) instead of dropping the tag, and
// `render()` below evaluates them against concrete parameter values. Each
// mode is then checked as the header text a browser would receive, rendered
// the way CloudFront documents each SecurityHeadersConfig field.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const TEMPLATE_PATH = path.join(__dirname, "..", "infrastructure/bootstrap/template.yaml");
const APEX = "example.test";

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

function loadTemplate() {
  return YAML.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"), { customTags: CFN_TAGS });
}

const NO_VALUE = Symbol("AWS::NoValue");

// Evaluates the intrinsics this template uses against `params`. A Ref to a
// resource stays a marker string; `${X}` in a Sub resolves a parameter.
function render(template, node, params) {
  const ev = (n) => render(template, n, params);
  if (Array.isArray(node)) return node.map(ev).filter((v) => v !== NO_VALUE);
  if (!node || typeof node !== "object") return node;
  if ("Ref" in node) {
    if (node.Ref === "AWS::NoValue") return NO_VALUE;
    if (node.Ref in params) return params[node.Ref];
    if (template.Resources[node.Ref]) return `<ref:${node.Ref}>`;
    throw new Error(`unresolved Ref ${node.Ref}`);
  }
  if ("Fn::Sub" in node) {
    return String(node["Fn::Sub"]).replace(/\$\{([^}]+)\}/g, (_, k) => {
      if (!(k in params)) throw new Error(`unresolved \${${k}} in Fn::Sub`);
      return params[k];
    });
  }
  if ("Fn::Equals" in node) {
    const [a, b] = node["Fn::Equals"].map(ev);
    return String(a) === String(b);
  }
  if ("Fn::Not" in node) return !ev(node["Fn::Not"][0]);
  if ("Fn::If" in node) {
    const [cond, yes, no] = node["Fn::If"];
    const holds = ev(template.Conditions[cond]);
    return ev(holds ? yes : no);
  }
  if ("Fn::GetAtt" in node) return `<getatt:${node["Fn::GetAtt"]}>`;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    const r = ev(v);
    if (r !== NO_VALUE) out[k] = r;
  }
  return out;
}

function parameters(template, overrides = {}) {
  const params = { ResourcePrefix: "example-test", ProductionDomainName: APEX };
  for (const [name, def] of Object.entries(template.Parameters)) {
    if ("Default" in def && !(name in params)) params[name] = def.Default;
  }
  return { ...params, ...overrides };
}

// The response headers a policy adds, rendered the way the CloudFront
// developer guide describes each SecurityHeadersConfig field.
function headersOf(policyConfig) {
  const h = {};
  const s = policyConfig.SecurityHeadersConfig || {};
  if (s.StrictTransportSecurity) {
    const t = s.StrictTransportSecurity;
    h["strict-transport-security"] = [
      `max-age=${t.AccessControlMaxAgeSec}`,
      t.IncludeSubdomains ? "includeSubDomains" : null,
      t.Preload ? "preload" : null,
    ]
      .filter(Boolean)
      .join("; ");
  }
  if (s.ContentTypeOptions) h["x-content-type-options"] = "nosniff";
  if (s.ReferrerPolicy) h["referrer-policy"] = s.ReferrerPolicy.ReferrerPolicy;
  if (s.FrameOptions) h["x-frame-options"] = s.FrameOptions.FrameOption;
  if (s.ContentSecurityPolicy) {
    h["content-security-policy"] = s.ContentSecurityPolicy.ContentSecurityPolicy;
  }
  const custom = (policyConfig.CustomHeadersConfig && policyConfig.CustomHeadersConfig.Items) || [];
  for (const item of custom) h[item.Header.toLowerCase()] = item.Value;
  return h;
}

function renderedPolicy(template, logicalId, params) {
  const resource = template.Resources[logicalId];
  expect(resource, `${logicalId} missing`).toBeTruthy();
  expect(resource.Type).toBe("AWS::CloudFront::ResponseHeadersPolicy");
  return render(template, resource.Properties.ResponseHeadersPolicyConfig, params);
}

function csp(value) {
  const directives = new Map();
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    expect(directives.has(name), `directive ${name} appears twice`).toBe(false);
    directives.set(name, sources);
  }
  return directives;
}

const DISTRIBUTIONS = ["PreviewDistribution", "ProductionDistribution"];
const BASELINE = { Ref: "BaselineResponseHeadersPolicy" };
const ADMIN = { Ref: "AdminResponseHeadersPolicy" };
const TOOL_APPS = { Ref: "ToolAppsResponseHeadersPolicy" };
const PUBLIC_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "frame-src",
  "object-src",
  "base-uri",
  "form-action",
];
const CSP_HEADERS = ["content-security-policy", "content-security-policy-report-only"];
const FULL_ADMIN_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "media-src",
  "connect-src",
  "font-src",
  "frame-src",
  "object-src",
  "base-uri",
];

test.describe("CloudFront security headers (cms-platform#515)", () => {
  const template = loadTemplate();

  for (const id of DISTRIBUTIONS) {
    const config = () => template.Resources[id].Properties.DistributionConfig;

    test(`${id}: the default behavior attaches the baseline policy`, () => {
      expect(config().DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual(BASELINE);
    });

    test(`${id}: /admin/* attaches the admin policy and otherwise equals the default behavior`, () => {
      const behaviors = config().CacheBehaviors || [];
      const admin = behaviors.filter((b) => b.PathPattern === "/admin/*");
      expect(admin.length, `${id} needs exactly one /admin/* cache behavior`).toBe(1);
      const { PathPattern, ResponseHeadersPolicyId, ...rest } = admin[0];
      expect(ResponseHeadersPolicyId).toEqual(ADMIN);
      const { ResponseHeadersPolicyId: _baseline, ...defaults } = config().DefaultCacheBehavior;
      // Called out separately because it is the one that breaks routing: a
      // preview /admin/* behavior without the viewer-request router would
      // fetch /admin/… from the bucket root instead of /pr-<N>/admin/….
      expect(rest.FunctionAssociations, `${id} /admin/* function associations`).toEqual(
        defaults.FunctionAssociations,
      );
      expect(rest.TargetOriginId).toBe(defaults.TargetOriginId);
      expect(rest).toEqual(defaults);
    });
  }

  test("the preview /admin/* behavior keeps the viewer-request router", () => {
    const admin = template.Resources.PreviewDistribution.Properties.DistributionConfig.CacheBehaviors.find(
      (b) => b.PathPattern === "/admin/*",
    );
    const events = (admin.FunctionAssociations || []).map((f) => f.EventType);
    expect(events).toContain("viewer-request");
  });

  test("policy names derive from ResourcePrefix and differ", () => {
    const params = parameters(template);
    const names = [
      "BaselineResponseHeadersPolicy",
      "AdminResponseHeadersPolicy",
      "ToolAppsResponseHeadersPolicy",
    ].map((id) => {
      const raw = template.Resources[id].Properties.ResponseHeadersPolicyConfig.Name;
      expect(raw["Fn::Sub"], `${id}.Name must be a !Sub over ResourcePrefix`).toContain(
        "${ResourcePrefix}",
      );
      return render(template, raw, params);
    });
    expect(new Set(names).size).toBe(3);
  });

  test("defaults: one-year host-only HSTS, admin CSP in report-only", () => {
    const p = template.Parameters;
    expect(p.HstsMaxAgeSeconds.Default).toBe(31536000);
    expect(p.HstsScope.Default).toBe("this-host-only");
    expect(p.AdminCspMode.Default).toBe("report-only");
    expect(p.AdminCspMode.AllowedValues).toEqual(["report-only", "enforce"]);
  });

  test("baseline headers, rendered with the defaults", () => {
    const h = headersOf(renderedPolicy(template, "BaselineResponseHeadersPolicy", parameters(template)));
    expect(h).toEqual({
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": "frame-ancestors 'self'",
      "content-security-policy-report-only": h["content-security-policy-report-only"],
    });
    expect(h["content-security-policy-report-only"], "the public policy is reported by default").toBeTruthy();
  });

  test("HstsScope widens HSTS only when asked", () => {
    const hsts = (scope) =>
      headersOf(
        renderedPolicy(template, "BaselineResponseHeadersPolicy", parameters(template, { HstsScope: scope })),
      )["strict-transport-security"];
    expect(hsts("include-subdomains")).toBe("max-age=31536000; includeSubDomains");
    expect(hsts("include-subdomains-preload")).toBe("max-age=31536000; includeSubDomains; preload");
  });

  test("every policy overrides an origin header of the same name", () => {
    for (const id of [
      "BaselineResponseHeadersPolicy",
      "AdminResponseHeadersPolicy",
      "ToolAppsResponseHeadersPolicy",
    ]) {
      const config = renderedPolicy(template, id, parameters(template));
      for (const [name, value] of Object.entries(config.SecurityHeadersConfig)) {
        expect(value.Override, `${id} ${name}.Override`).toBe(true);
      }
      for (const item of (config.CustomHeadersConfig && config.CustomHeadersConfig.Items) || []) {
        expect(item.Override, `${id} ${item.Header}.Override`).toBe(true);
      }
    }
  });

  for (const mode of ["report-only", "enforce"]) {
    test(`admin policy repeats the baseline (AdminCspMode=${mode})`, () => {
      const params = parameters(template, { AdminCspMode: mode });
      const base = headersOf(renderedPolicy(template, "BaselineResponseHeadersPolicy", params));
      const admin = headersOf(renderedPolicy(template, "AdminResponseHeadersPolicy", params));
      for (const name of Object.keys(base).filter((n) => !CSP_HEADERS.includes(n))) {
        expect(admin[name], name).toBe(base[name]);
      }
    });
  }

  test("report-only: frame-ancestors enforced, the full policy only reported", () => {
    const h = headersOf(renderedPolicy(template, "AdminResponseHeadersPolicy", parameters(template)));
    expect(h["content-security-policy"]).toBe("frame-ancestors 'self'");
    const reported = csp(h["content-security-policy-report-only"]);
    expect([...reported.keys()]).toEqual(FULL_ADMIN_DIRECTIVES);
    // Decap fetch()es an uploaded image's blob: URL back before committing it (#627).
    expect(reported.get("connect-src")).toContain("blob:");
  });

  test("enforce: the full policy is enforced and nothing is report-only", () => {
    const params = parameters(template, { AdminCspMode: "enforce" });
    const h = headersOf(renderedPolicy(template, "AdminResponseHeadersPolicy", params));
    expect(h["content-security-policy-report-only"]).toBeUndefined();
    const enforced = csp(h["content-security-policy"]);
    expect([...enforced.keys()]).toEqual([...FULL_ADMIN_DIRECTIVES, "frame-ancestors"]);
    expect(enforced.get("frame-ancestors")).toEqual(["'self'"]);
  });

  test("both modes send the same admin directives", () => {
    const reportOnly = headersOf(renderedPolicy(template, "AdminResponseHeadersPolicy", parameters(template)));
    const enforce = headersOf(
      renderedPolicy(template, "AdminResponseHeadersPolicy", parameters(template, { AdminCspMode: "enforce" })),
    );
    expect(enforce["content-security-policy"]).toBe(
      `${reportOnly["content-security-policy-report-only"]}; frame-ancestors 'self'`,
    );
  });

  test("admin CSP invariants", () => {
    const params = parameters(template, { AdminCspMode: "enforce" });
    const value = headersOf(renderedPolicy(template, "AdminResponseHeadersPolicy", params))[
      "content-security-policy"
    ];
    // CloudFront's documented limit on a Content-Security-Policy value.
    expect(value.length).toBeLessThanOrEqual(1783);
    const d = csp(value);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("default-src")).toEqual(["'self'"]);
    // blob: lets Decap fetch() an uploaded image back before committing it (#627).
    // An iframe embed in Decap's preview pane, which inherits this policy (#687).
    expect(d.get("frame-src")).toEqual(["'self'", `https://${APEX}`, `https://*.${APEX}`]);
    expect(d.get("connect-src")).toEqual([
      "'self'",
      "blob:",
      `https://${APEX}`,
      `https://*.${APEX}`,
      "https://api.github.com",
      "https://www.githubstatus.com",
    ]);
    expect(d.get("script-src")).toContain("https://unpkg.com");
    for (const [name, sources] of d) {
      for (const src of sources) {
        expect(src, `${name}: a bare wildcard allows every host`).not.toBe("*");
        expect(src, `${name}: a scheme-only source allows every host`).not.toMatch(/^(https?|wss?):$/);
        if (src.includes("*")) {
          expect(src, `${name}: a wildcard may only name the apex's own subdomains`).toBe(`https://*.${APEX}`);
        }
        if (/^[a-z]+:\/\//.test(src)) {
          expect(src, `${name}: only https:// hosts`).toMatch(/^https:\/\//);
        }
      }
    }
  });
});

// cms-platform#1067: one post could put an outside script, frame or stylesheet
// on a page, and a <base> pasted into a post body sent every menu link on that
// page to another site. The public policy is "nothing from another host".
test.describe("the public Content-Security-Policy (cms-platform#1067)", () => {
  const template = loadTemplate();
  const RUM = "https://dataplane.rum.us-east-1.amazonaws.com https://cognito-identity.us-east-1.amazonaws.com";
  const baseline = (overrides) =>
    headersOf(renderedPolicy(template, "BaselineResponseHeadersPolicy", parameters(template, overrides)));
  const toolApps = (overrides) =>
    headersOf(renderedPolicy(template, "ToolAppsResponseHeadersPolicy", parameters(template, overrides)));

  test("defaults: report-only, no extra connect sources, tool apps on the public policy", () => {
    const p = template.Parameters;
    expect(p.PublicCspMode.Default).toBe("report-only");
    expect(p.PublicCspMode.AllowedValues).toEqual(["report-only", "enforce"]);
    expect(p.PublicCspConnectSrc.Default).toBe("");
    expect(p.ToolAppsCsp.Default).toBe("");
  });

  test("a parameter cannot smuggle in another directive", () => {
    // `;` ends a directive and `,` ends a policy in a combined header: a
    // connect-src value carrying either would add one.
    const connect = new RegExp(template.Parameters.PublicCspConnectSrc.AllowedPattern);
    expect(connect.test(RUM)).toBe(true);
    expect(connect.test("")).toBe(true);
    expect(connect.test("https://example.net; script-src *")).toBe(false);
    expect(connect.test("https://example.net, default-src *")).toBe(false);
  });

  test("report-only: frame-ancestors enforced, the full policy only reported", () => {
    const h = baseline();
    expect(h["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect([...csp(h["content-security-policy-report-only"]).keys()]).toEqual(PUBLIC_DIRECTIVES);
  });

  test("enforce: the full policy is enforced and nothing is report-only", () => {
    const h = baseline({ PublicCspMode: "enforce" });
    expect(h["content-security-policy-report-only"]).toBeUndefined();
    const enforced = csp(h["content-security-policy"]);
    expect([...enforced.keys()]).toEqual([...PUBLIC_DIRECTIVES, "frame-ancestors"]);
    expect(enforced.get("frame-ancestors")).toEqual(["'self'"]);
  });

  test("both modes send the same directives", () => {
    expect(baseline({ PublicCspMode: "enforce" })["content-security-policy"]).toBe(
      `${baseline()["content-security-policy-report-only"]}; frame-ancestors 'self'`,
    );
  });

  test("nothing loads from another host", () => {
    const value = baseline({ PublicCspMode: "enforce" })["content-security-policy"];
    // CloudFront's documented limit on a Content-Security-Policy value.
    expect(value.length).toBeLessThanOrEqual(1783);
    const d = csp(value);
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri"), "a <base> in a post body must not redirect the page's links").toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("frame-src"), "no outside embed").toEqual(["'self'"]);
    expect(d.get("media-src")).toEqual(["'self'"]);
    for (const name of ["script-src", "style-src"]) {
      expect(d.get(name), `${name} names no host`).toEqual(["'self'", "'unsafe-inline'"]);
    }
    expect(d.get("script-src"), "no eval on a public page").not.toContain("'unsafe-eval'");
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(d.get("font-src")).toEqual(["'self'", "data:"]);
    // The live preview page reads a draft image from the entry's branch.
    expect(d.get("connect-src")).toEqual(["'self'", "https://api.github.com"]);
    for (const [name, sources] of d) {
      for (const src of sources) {
        expect(src, `${name}: no wildcard`).not.toContain("*");
        expect(src, `${name}: a scheme-only source allows every host`).not.toMatch(/^(https?|wss?):$/);
      }
    }
  });

  test("PublicCspConnectSrc adds a site's reporting endpoints to connect-src and nowhere else", () => {
    const plain = csp(baseline({ PublicCspMode: "enforce" })["content-security-policy"]);
    const withRum = csp(
      baseline({ PublicCspMode: "enforce", PublicCspConnectSrc: RUM })["content-security-policy"],
    );
    expect(withRum.get("connect-src")).toEqual(["'self'", "https://api.github.com", ...RUM.split(" ")]);
    for (const name of PUBLIC_DIRECTIVES.filter((n) => n !== "connect-src")) {
      expect(withRum.get(name), name).toEqual(plain.get(name));
    }
  });

  for (const id of DISTRIBUTIONS) {
    test(`${id}: /assets/tools/* attaches the tool-apps policy and otherwise equals the default behavior`, () => {
      const config = template.Resources[id].Properties.DistributionConfig;
      const matches = (config.CacheBehaviors || []).filter((b) => b.PathPattern === "/assets/tools/*");
      expect(matches.length, `${id} needs exactly one /assets/tools/* cache behavior`).toBe(1);
      const { PathPattern, ResponseHeadersPolicyId, ...rest } = matches[0];
      expect(ResponseHeadersPolicyId).toEqual(TOOL_APPS);
      const { ResponseHeadersPolicyId: _baseline, ...defaults } = config.DefaultCacheBehavior;
      // The preview router must be on it, or a preview host would fetch
      // /assets/tools/… from the bucket root instead of /pr-<N>/assets/tools/….
      expect(rest.FunctionAssociations, `${id} /assets/tools/* function associations`).toEqual(
        defaults.FunctionAssociations,
      );
      expect(rest).toEqual(defaults);
    });
  }

  for (const mode of ["report-only", "enforce"]) {
    test(`tool apps: with no ToolAppsCsp they get exactly the public headers (PublicCspMode=${mode})`, () => {
      const overrides = { PublicCspMode: mode, PublicCspConnectSrc: RUM };
      expect(toolApps(overrides)).toEqual(baseline(overrides));
    });

    test(`tool apps: ToolAppsCsp replaces the policy and keeps every other header (PublicCspMode=${mode})`, () => {
      const own = "default-src 'self'; connect-src 'self' https://raw.githubusercontent.com";
      const overrides = { PublicCspMode: mode, ToolAppsCsp: own };
      const tools = toolApps(overrides);
      const base = baseline(overrides);
      for (const name of Object.keys(base).filter((n) => !CSP_HEADERS.includes(n))) {
        expect(tools[name], name).toBe(base[name]);
      }
      if (mode === "enforce") {
        expect(tools["content-security-policy"]).toBe(`${own}; frame-ancestors 'self'`);
        expect(tools["content-security-policy-report-only"]).toBeUndefined();
      } else {
        expect(tools["content-security-policy"]).toBe("frame-ancestors 'self'");
        expect(tools["content-security-policy-report-only"]).toBe(own);
      }
      // The site's choice for its apps never reaches a post or a page.
      expect(JSON.stringify(base)).not.toContain("raw.githubusercontent.com");
    });
  }

  test("the admin and regression.json policies are untouched by the public parameters", () => {
    const overrides = { PublicCspMode: "enforce", PublicCspConnectSrc: RUM, ToolAppsCsp: "default-src 'self'" };
    for (const id of ["AdminResponseHeadersPolicy", "PreviewRegressionCorsResponseHeadersPolicy"]) {
      expect(renderedPolicy(template, id, parameters(template, overrides)), id).toEqual(
        renderedPolicy(template, id, parameters(template)),
      );
    }
  });
});

// cms-platform#789: /admin/reviews fetch()es preview-pr<N>.<apex>/regression.json
// from the site's origin, and the preview hosts sent no Access-Control-Allow-Origin.
test.describe("preview regression.json CORS (cms-platform#789)", () => {
  const template = loadTemplate();
  const POLICY_ID = "PreviewRegressionCorsResponseHeadersPolicy";
  const POLICY = { Ref: POLICY_ID };
  const previewConfig = () => template.Resources.PreviewDistribution.Properties.DistributionConfig;
  const cors = (overrides) => renderedPolicy(template, POLICY_ID, parameters(template, overrides)).CorsConfig;

  test("PreviewDistribution routes /regression.json to the CORS policy, otherwise equal to the default behavior", () => {
    const matches = (previewConfig().CacheBehaviors || []).filter((b) => b.PathPattern === "/regression.json");
    expect(matches.length, "exactly one /regression.json cache behavior").toBe(1);
    const { PathPattern, ResponseHeadersPolicyId, ...rest } = matches[0];
    expect(ResponseHeadersPolicyId).toEqual(POLICY);
    const { ResponseHeadersPolicyId: _baseline, ...defaults } = previewConfig().DefaultCacheBehavior;
    // The router maps the host to pr-<N>/; without it the fetch reads the bucket root.
    expect(rest.FunctionAssociations.map((f) => f.EventType)).toContain("viewer-request");
    expect(rest).toEqual(defaults);
  });

  test("the default and /admin/* behaviors do not carry the CORS policy", () => {
    expect(previewConfig().DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual(BASELINE);
    const admin = previewConfig().CacheBehaviors.find((b) => b.PathPattern === "/admin/*");
    expect(admin.ResponseHeadersPolicyId).toEqual(ADMIN);
  });

  test("ProductionDistribution does not serve the CORS policy", () => {
    const prod = template.Resources.ProductionDistribution.Properties.DistributionConfig;
    const behaviors = [prod.DefaultCacheBehavior, ...(prod.CacheBehaviors || [])];
    for (const b of behaviors) expect(b.ResponseHeadersPolicyId).not.toEqual(POLICY);
  });

  test("the policy name derives from ResourcePrefix and differs from the other policies", () => {
    const raw = template.Resources[POLICY_ID].Properties.ResponseHeadersPolicyConfig.Name;
    expect(raw["Fn::Sub"]).toContain("${ResourcePrefix}");
    const params = parameters(template);
    const names = [POLICY_ID, "BaselineResponseHeadersPolicy", "AdminResponseHeadersPolicy"].map(
      (id) => render(template, template.Resources[id].Properties.ResponseHeadersPolicyConfig.Name, params),
    );
    expect(new Set(names).size).toBe(3);
  });

  test("allows GET and HEAD from the site's apex and www only, without credentials", () => {
    const c = cors();
    expect(c.AccessControlAllowOrigins.Items).toEqual([`https://${APEX}`, `https://www.${APEX}`]);
    expect(c.AccessControlAllowMethods.Items).toEqual(["GET", "HEAD"]);
    expect(c.AccessControlAllowCredentials).toBe(false);
    expect(c.OriginOverride).toBe(true);
  });

  test("the opt-in admin origin (AdminDomainName) is allowed only when set", () => {
    const admin = `admin.${APEX}`;
    expect(cors({ AdminDomainName: admin }).AccessControlAllowOrigins.Items).toEqual([
      `https://${APEX}`,
      `https://www.${APEX}`,
      `https://${admin}`,
    ]);
    expect(cors({ AdminDomainName: "" }).AccessControlAllowOrigins.Items).toHaveLength(2);
  });

  test("origins derive from the template parameters, not a hardcoded site", () => {
    const other = "another-site.test";
    const items = cors({ ProductionDomainName: other, AdminDomainName: `admin.${other}` })
      .AccessControlAllowOrigins.Items;
    expect(items).toEqual([`https://${other}`, `https://www.${other}`, `https://admin.${other}`]);
    for (const origin of items) expect(origin).not.toContain(APEX);
  });

  test("no wildcard origin, method or credentials, and no preflight method", () => {
    const c = cors({ AdminDomainName: `admin.${APEX}` });
    for (const origin of c.AccessControlAllowOrigins.Items) {
      expect(origin, "an exact https origin, never a wildcard").toMatch(/^https:\/\/[a-z0-9.-]+$/);
      expect(origin).not.toContain("*");
    }
    expect(c.AccessControlAllowMethods.Items).not.toContain("ALL");
    expect(c.AccessControlAllowMethods.Items).not.toContain("OPTIONS");
    expect(c.AccessControlAllowCredentials).toBe(false);
    expect(c.AccessControlAllowHeaders.Items).not.toContain("*");
    expect(c.AccessControlExposeHeaders).toBeUndefined();
  });

  for (const mode of ["report-only", "enforce"]) {
    test(`keeps every baseline security header, overridden (AdminCspMode=${mode})`, () => {
      const params = parameters(template, { AdminCspMode: mode });
      const policy = renderedPolicy(template, POLICY_ID, params);
      const base = renderedPolicy(template, "BaselineResponseHeadersPolicy", params);
      // Every baseline header but the public page policy (#1067): this
      // behavior serves one JSON file, which loads nothing, so it keeps the
      // framing rule alone in both PublicCspMode values.
      const { ContentSecurityPolicy: policyCsp, ...policyRest } = policy.SecurityHeadersConfig;
      const { ContentSecurityPolicy: _baseCsp, ...baseRest } = base.SecurityHeadersConfig;
      expect(policyRest).toEqual(baseRest);
      expect(policyCsp).toEqual({ ContentSecurityPolicy: "frame-ancestors 'self'", Override: true });
      const headers = headersOf(policy);
      const baseHeaders = headersOf(base);
      for (const name of Object.keys(baseHeaders).filter((n) => !CSP_HEADERS.includes(n))) {
        expect(headers[name], name).toBe(baseHeaders[name]);
      }
      expect(headers["content-security-policy-report-only"]).toBeUndefined();
      for (const [name, value] of Object.entries(policy.SecurityHeadersConfig)) {
        expect(value.Override, `${name}.Override`).toBe(true);
      }
    });
  }
});
