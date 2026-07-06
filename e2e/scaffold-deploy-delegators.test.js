// @lane: local — pure-fs invariant: a scaffolded site DELEGATES its OAuth-proxy
// and bootstrap deploys to the platform (checkout-at-platform_ref) instead of
// VENDORING the proxy lambda/template or the bootstrap CloudFormation (#69).
//
// Why: consumers used to fork oauth-proxy/{lambda.py,template.yaml} and drift
// (stale /prod/health handler, narrower OAuth scope). The platform's proxy +
// bootstrap stacks are fully parameterized, so a new site should commit ONLY a
// thin delegating deploy.sh that clones the platform at platform_ref and execs
// the platform's deploy.sh — never the vendored sources. This locks that.
const { test, expect } = require("./base");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");

test.describe("scaffolder delivers OAuth-proxy + bootstrap as delegating wrappers, not vendored sources (#69)", () => {
  let target;
  test.beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "cms69-scaffold-"));
    // --platform-ref pins the version so this test never hits the network.
    execFileSync(
      "node",
      [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner", "--platform-ref", "v0.1.52"],
      { stdio: "pipe" },
    );
  });
  test.afterAll(() => {
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  for (const rel of ["oauth-proxy/deploy.sh", "infrastructure/bootstrap/deploy.sh"]) {
    test(`emits ${rel} as an executable delegating wrapper`, () => {
      const p = path.join(target, rel);
      expect(fs.existsSync(p), `scaffolder must emit ${rel}`).toBe(true);
      const body = fs.readFileSync(p, "utf8");
      // Delegation markers: reads platform.lock, checks the platform out into
      // .cms-platform/, and execs the platform's deploy.sh at that ref.
      expect(body, `${rel}: must read platform.lock`).toMatch(/platform\.lock/);
      expect(body, `${rel}: must check the platform out into .cms-platform/`).toMatch(/\.cms-platform/);
      expect(body, `${rel}: must clone the platform at platform_ref`).toMatch(/git clone .*--branch "\$PLATFORM_REF"/);
      expect(body, `${rel}: must exec the platform deploy.sh, not deploy a vendored template`).toMatch(
        /exec bash "\$PLATFORM_DEPLOY"/,
      );
      // Executable bit (the user runs `bash <rel>`, but make it +x anyway).
      expect((fs.statSync(p).mode & 0o111) !== 0, `${rel}: must be executable`).toBe(true);
    });
  }

  test("oauth delegator adopts the platform default OAuth scope (repo,user,workflow) — no narrowed fork", () => {
    const body = fs.readFileSync(path.join(target, "oauth-proxy/deploy.sh"), "utf8");
    // It must NOT hardcode a narrower scope; the platform deploy.sh defaults to
    // repo,user,workflow. (A fork's GITHUB_SCOPE=repo,user is exactly the drift
    // #69 eliminates.) The wrapper mentions the default scope for the operator.
    expect(body).toMatch(/repo,user,workflow/);
    expect(body, "oauth delegator must not pin a narrower scope").not.toMatch(/GITHUB_SCOPE=.?repo,user[^,]/);
  });

  test("does NOT vendor the OAuth proxy sources (lambda.py / template.yaml / test_lambda.py)", () => {
    for (const f of ["oauth-proxy/lambda.py", "oauth-proxy/template.yaml", "oauth-proxy/test_lambda.py"]) {
      expect(
        fs.existsSync(path.join(target, f)),
        `scaffolded site must NOT vendor ${f} — it is delivered from the platform (#69)`,
      ).toBe(false);
    }
  });

  test("does NOT vendor the bootstrap CloudFormation template", () => {
    expect(
      fs.existsSync(path.join(target, "infrastructure/bootstrap/template.yaml")),
      "scaffolded site must NOT vendor the bootstrap template — delivered from the platform",
    ).toBe(false);
  });

  test("the platform ships the delegating templates the scaffolder emits", () => {
    for (const t of ["oauth-proxy/deploy.sh.delegating", "infrastructure/bootstrap/deploy.sh.delegating"]) {
      expect(fs.existsSync(path.join(REPO_ROOT, t)), `platform must ship ${t}`).toBe(true);
    }
  });
});
