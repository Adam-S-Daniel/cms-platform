// @lane: local — pure-Node behavioral test for editor-component-image.js (vm sandbox)
/*
 * cms-platform#648: Decap's stock Image editor component serializes an Image
 * block the author left empty as a literal `![]()` line, which renders as a
 * broken image. editor-component-image.js re-registers the component under
 * the same id with a `toBlock` that writes nothing when no image was chosen.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/editor-component-image.js"), "utf8");

function load() {
  const registered = [];
  const sandbox = {
    window: { CMS: { registerEditorComponent: (c) => registered.push(c) } },
    document: { readyState: "complete", addEventListener() {} },
    setTimeout() {},
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return registered;
}

test.describe("Image editor component (#648)", () => {
  test("registers once, under Decap's stock id, with the stock fields", () => {
    const registered = load();
    expect(registered).toHaveLength(1);
    expect(registered[0].id).toBe("image");
    expect(registered[0].fields.map((f) => f.name)).toEqual(["image", "alt", "title"]);
  });

  test("an empty block writes nothing, not `![]()`", () => {
    const { toBlock } = load()[0];
    for (const data of [undefined, {}, { image: "" }, { alt: "", image: "", title: "" }]) {
      expect(toBlock(data)).toBe("");
    }
  });

  test("a block with an image keeps the stock markdown shape", () => {
    const { toBlock } = load()[0];
    expect(toBlock({ image: "/a.png" })).toBe("![](/a.png)");
    expect(toBlock({ image: "/a.png", alt: "A" })).toBe("![A](/a.png)");
    expect(toBlock({ image: "/a.png", alt: "A", title: 'say "hi"' })).toBe('![A](/a.png "say \\"hi\\"")');
  });

  test("the pattern and parser round-trip the block it writes", () => {
    const c = load()[0];
    const md = c.toBlock({ image: "/a.png", alt: "A", title: "T" });
    expect(c.fromBlock(c.pattern.exec(md))).toEqual({ image: "/a.png", alt: "A", title: "T" });
  });
});
