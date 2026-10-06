// @lane: local — pure-Node behavioral test for tags-input.js's suggestion logic (vm sandbox, no browser)
/*
 * cms-platform#735: nothing told a writer which tags already exist, so `quote`
 * and `Quotes` could be created beside `quotes`, each with its own archive
 * page. tags-input.js now offers existing tags as you type and warns when a
 * typed tag differs from an existing one only by case, plural, spaces or
 * hyphens. The analysis is pure (no DOM), exposed as window.__tagsInput; the
 * real-editor half is cms-tags-input.spec.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/tags-input.js"), "utf8");

function load() {
  const sandbox = {
    window: {},
    document: { addEventListener() {} },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.window.__tagsInput;
}

const EXISTING = ["AI Engineering", "quotes", "release", "news", "Quotes of the day"];

test.describe("tags-input.js existing-tag suggestions (#735)", () => {
  test("the shim exposes its pure helpers", () => {
    const t = load();
    expect(typeof t.analyze).toBe("function");
    expect(typeof t.replaceTag).toBe("function");
  });

  test("`quo` offers `quotes` (and the longer one) without calling it a duplicate", () => {
    const { analyze } = load();
    const a = analyze("quo", EXISTING);
    expect(a.suggest).toEqual(["quotes", "Quotes of the day"]);
    expect(a.near).toEqual([]);
  });

  test("`quote` and `Quotes` are flagged as near-duplicates of `quotes`", () => {
    const { analyze } = load();
    expect(analyze("quote", EXISTING).near).toEqual([{ index: 0, typed: "quote", matches: ["quotes"] }]);
    expect(analyze("Quotes", EXISTING).near).toEqual([{ index: 0, typed: "Quotes", matches: ["quotes"] }]);
  });

  test("hyphen and spacing variants match too, and a completed tag stays flagged", () => {
    const { analyze } = load();
    const a = analyze("ai-engineering, zz, ", EXISTING);
    expect(a.near).toEqual([{ index: 0, typed: "ai-engineering", matches: ["AI Engineering"] }]);
    expect(a.suggest).toEqual([]);
  });

  test("an exact existing tag, or a brand-new one, raises nothing", () => {
    const { analyze } = load();
    expect(analyze("quotes", EXISTING)).toMatchObject({ near: [], suggest: ["Quotes of the day"] });
    expect(analyze("brand-new-thing", EXISTING)).toMatchObject({ near: [], suggest: [] });
    expect(analyze("", EXISTING)).toMatchObject({ near: [], suggest: [] });
  });

  test("short words are not read as plurals (`news` is not `new`)", () => {
    const { analyze } = load();
    expect(analyze("new", ["news"]).near).toEqual([]);
  });

  test("with no existing tags (page missing) there is nothing to say", () => {
    const { analyze } = load();
    expect(analyze("quote, anything", [])).toMatchObject({ near: [], suggest: [] });
    expect(analyze("quote", undefined)).toMatchObject({ near: [], suggest: [] });
  });

  test("tags already in the box are not offered again", () => {
    const { analyze } = load();
    expect(analyze("release, rel", EXISTING).suggest).toEqual([]);
  });

  // #756: applying a suggestion ends the tag, so the next one can be typed at once.
  test("replaceTag swaps one piece and ends it with `, ` (#756)", () => {
    const { replaceTag } = load();
    expect(replaceTag("quo", 0, "quotes")).toBe("quotes, ");
    expect(replaceTag("alpha, quo", 1, "quotes")).toBe("alpha,quotes, ");
    expect(replaceTag("quote, beta", 0, "quotes")).toBe("quotes,beta, ");
  });

  test("replaceTag never leaves an empty piece behind a trailing comma (#756)", () => {
    const { replaceTag } = load();
    expect(replaceTag("quote, beta, ", 0, "quotes")).toBe("quotes,beta, ");
    expect(replaceTag("quote, ", 0, "quotes")).toBe("quotes, ");
  });

  // #756: Decap trims the box on every keystroke, so an in-progress trailing space
  // must be hidden from it. Only a space after a letter, with the caret at the end.
  test("holdsTrailingSpace is true only for a lone space after a letter at the caret end (#756)", () => {
    const { holdsTrailingSpace } = load();
    expect(holdsTrailingSpace("field ", true)).toBe(true);
    expect(holdsTrailingSpace("agents, field ", true)).toBe(true);
    expect(holdsTrailingSpace("field ", false)).toBe(false);
    expect(holdsTrailingSpace("field", true)).toBe(false);
    expect(holdsTrailingSpace("agents, ", true)).toBe(false);
    expect(holdsTrailingSpace("agents,", true)).toBe(false);
    expect(holdsTrailingSpace("field  ", true)).toBe(false);
    expect(holdsTrailingSpace(" ", true)).toBe(false);
    expect(holdsTrailingSpace("", true)).toBe(false);
  });
});
