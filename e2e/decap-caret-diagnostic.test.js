const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const { readShell, verifyBundle } = require("./decap-caret-diagnostic");

const fixture = Buffer.from("neutral bundle fixture");
const sri = `sha384-${createHash("sha384").update(fixture).digest("base64")}`;

test("diagnostic derives the one stock pin and platform file order from the local shell", async () => {
  const { pin, scripts } = await readShell();
  expect(scripts.filter(({ src }) => src.startsWith("https://"))).toEqual([pin]);
  expect(scripts.findIndex(({ src }) => src === "confirm-wrap-local-backup.js")).toBeLessThan(scripts.indexOf(pin));
  expect(scripts.findIndex(({ src }) => src === "preview-pane.js")).toBeGreaterThan(scripts.indexOf(pin));
  expect(pin.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
});

test("diagnostic accepts a bundle matching the requested SRI", () => {
  expect(verifyBundle(fixture, sri)).toEqual(fixture);
});

test("diagnostic rejects a changed bundle or missing SRI before routing it", () => {
  expect(() => verifyBundle(Buffer.from("changed fixture"), sri)).toThrow("does not match");
  expect(() => verifyBundle(fixture, undefined)).toThrow("does not match");
});
