// @lane: local — pure-fs lint, parses the CloudFormation template with the
// real `yaml` package (never a regex over source); no network, no browser.
//
// cms-platform#515 — both CloudFront distributions in
// infrastructure/bootstrap/template.yaml attach response headers policies:
// a baseline on the default behavior, and an /admin/* behavior whose policy
// repeats the baseline and adds the admin Content-Security-Policy, sent as
// Report-Only until AdminCspMode is flipped to `enforce`.
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
    const [admin] = template.Resources.PreviewDistribution.Properties.DistributionConfig.CacheBehaviors;
    const events = (admin.FunctionAssociations || []).map((f) => f.EventType);
    expect(events).toContain("viewer-request");
  });

  test("policy names derive from ResourcePrefix and differ", () => {
    const params = parameters(template);
    const names = ["BaselineResponseHeadersPolicy", "AdminResponseHeadersPolicy"].map((id) => {
      const raw = template.Resources[id].Properties.ResponseHeadersPolicyConfig.Name;
      expect(raw["Fn::Sub"], `${id}.Name must be a !Sub over ResourcePrefix`).toContain(
        "${ResourcePrefix}",
      );
      return render(template, raw, params);
    });
    expect(new Set(names).size).toBe(2);
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
    });
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
    for (const id of ["BaselineResponseHeadersPolicy", "AdminResponseHeadersPolicy"]) {
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
      for (const name of Object.keys(base).filter((n) => n !== "content-security-policy")) {
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
