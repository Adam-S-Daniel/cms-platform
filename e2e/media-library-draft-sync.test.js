// @lane: local — pure-Node sandbox unit tests for the media-library draft-sync shim
/*
 * Unit tests for theme/admin/media-library-draft-sync.js (cms-platform#647):
 * on a tab whose first route is the editor, Decap builds the draft from the
 * media library before the library has loaded, and the image picker, which
 * lists the draft's copy, says "No images found". The shim holds a draft
 * until the library has loaded and adds the library's files to it. The
 * file's header has the Decap source references.
 *
 * Three parts:
 *   - the Redux DevTools compose hook it defines: picked up by the real
 *     redux-devtools-extension module Decap's bundle builds its store with,
 *     and chained to an extension that was already installed;
 *   - the draft logic, against a real redux store (redux + redux-thunk, the
 *     versions decap-cms-core pulls in) whose reducer mirrors the slices of
 *     Decap's state the shim reads, driven through the same action sequence
 *     Decap dispatches on a direct /new route;
 *   - where it loads: non-deferred and before decap-cms.js in all three admin
 *     shells. Lexical scan of literal <script> tags, the
 *     admin-shim-load-order.test.js precedent.
 *
 * No network, no clock: the hold timeout runs on an injected scheduler.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createStore, applyMiddleware } = require("redux");
const thunk = require("redux-thunk").default;
const { Map } = require("immutable");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "media-library-draft-sync.js"), "utf8");

const ALPHA = { id: "a", name: "alpha.png", path: "assets/images/uploads/alpha.png" };
const BETA = { id: "b", name: "beta.png", path: "assets/images/uploads/beta.png" };

// Loads the shim into a fresh sandbox window. `prior` stands in for a Redux
// DevTools extension that defined the hook first.
function load({ prior } = {}) {
  const timers = [];
  const win = {
    setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimeout: (h) => {
      if (timers[h]) timers[h].cancelled = true;
    },
  };
  if (prior) win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = prior;
  const sandbox = { window: win };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  expect(win.CMSMediaDraftSync, "must expose window.CMSMediaDraftSync").toBeTruthy();
  expect(typeof win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBe("function");
  const fire = () =>
    timers.filter((t) => !t.cancelled && !t.fired).forEach((t) => {
      t.fired = true;
      t.fn();
    });
  return { win, timers, fire };
}

// The slices of Decap's state the shim reads, reduced the way Decap's own
// reducers do: MEDIA_LOAD_REQUEST sets isLoading, MEDIA_LOAD_SUCCESS stores
// files, the draft-create actions replace entryDraft.entry.
function decapLikeReducer(state = { mediaLibrary: Map({ isVisible: false }), entryDraft: Map() }, action) {
  switch (action.type) {
    case "MEDIA_LIBRARY_CREATE":
      return { ...state, mediaLibrary: state.mediaLibrary.set("externalLibrary", action.payload) };
    case "MEDIA_LOAD_REQUEST":
      return { ...state, mediaLibrary: state.mediaLibrary.set("isLoading", true) };
    case "MEDIA_LOAD_SUCCESS":
      return {
        ...state,
        mediaLibrary: state.mediaLibrary.set("isLoading", false).set("files", action.payload.files),
      };
    case "MEDIA_LOAD_FAILURE":
      return { ...state, mediaLibrary: state.mediaLibrary.set("isLoading", false) };
    case "DRAFT_CREATE_EMPTY":
      return { ...state, entryDraft: Map({ entry: action.payload }) };
    case "DRAFT_CREATE_FROM_ENTRY":
      return { ...state, entryDraft: Map({ entry: action.payload.entry }) };
    case "DRAFT_DISCARD":
      return { ...state, entryDraft: Map() };
    default:
      return state;
  }
}

// A store built the way Decap's redux/index.ts builds it:
// composeWithDevTools(applyMiddleware(thunk, ...)), with the shim's hook as
// the compose.
function decapStore(win) {
  return createStore(decapLikeReducer, win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(applyMiddleware(thunk)));
}

const emptyDraft = (mediaFiles = []) => ({ type: "DRAFT_CREATE_EMPTY", payload: { collection: "posts", slug: "", mediaFiles } });
const draftFromEntry = (mediaFiles = []) => ({
  type: "DRAFT_CREATE_FROM_ENTRY",
  payload: { entry: { collection: "posts", slug: "hello", mediaFiles } },
});
const draftFiles = (store) => {
  const entry = store.getState().entryDraft.get("entry");
  return entry ? entry.mediaFiles.map((f) => f.name) : null;
};

test.describe("media-library-draft-sync.js compose hook", () => {
  test("the redux-devtools-extension module Decap bundles picks the hook up", () => {
    const { win } = load();
    const modulePath = require.resolve("redux-devtools-extension");
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const before = globalThis.window;
    delete require.cache[modulePath];
    globalThis.window = win;
    let composeWithDevTools;
    try {
      ({ composeWithDevTools } = require(modulePath));
    } finally {
      delete require.cache[modulePath];
      if (hadWindow) globalThis.window = before;
      else delete globalThis.window;
    }
    expect(composeWithDevTools).toBe(win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__);
  });

  test("chains to a Redux DevTools extension that defined the hook first", () => {
    const calls = [];
    const prior = (...enhancers) => {
      calls.push(enhancers.length);
      return (createStoreFn) => enhancers.reduceRight((cs, e) => e(cs), createStoreFn);
    };
    const { win } = load({ prior });
    const store = decapStore(win);
    expect(calls).toEqual([1]);
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(emptyDraft());
    expect(draftFiles(store), "the draft is still held through the chained compose").toBeNull();
  });

  test("accepts composeWithDevTools' options form", () => {
    const { win } = load();
    const compose = win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__({ name: "decap" });
    const store = createStore(decapLikeReducer, compose(applyMiddleware(thunk)));
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA] } });
    store.dispatch(emptyDraft());
    expect(draftFiles(store)).toEqual(["alpha.png"]);
  });
});

test.describe("media-library-draft-sync.js drafts", () => {
  test("a direct /new route: the draft waits for the library, then lists it", async () => {
    const { win } = load();
    const store = decapStore(win);
    // Decap's order on a direct route: <Editor> mounts first and its thunk
    // snapshots state with no files; <MediaLibrary> then starts the load.
    const createEmptyDraft = () => async (dispatch, getState) => {
      const stale = getState();
      await Promise.resolve();
      const files = stale.mediaLibrary.get("files") || [];
      dispatch(emptyDraft([].concat(files)));
    };
    const pending = store.dispatch(createEmptyDraft());
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    await pending;
    expect(draftFiles(store), "no draft while the library is loading").toBeNull();
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA, BETA] } });
    expect(draftFiles(store)).toEqual(["alpha.png", "beta.png"]);
  });

  test("an entry route under editorial workflow gets the same treatment", () => {
    const { win } = load();
    const store = decapStore(win);
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(draftFromEntry());
    expect(draftFiles(store)).toBeNull();
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA] } });
    expect(draftFiles(store)).toEqual(["alpha.png"]);
    expect(store.getState().entryDraft.get("entry").slug).toBe("hello");
  });

  test("a draft built after the load from a stale snapshot gets the missing files, once each", () => {
    const { win } = load();
    const store = decapStore(win);
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA, BETA] } });
    const upload = { id: "u", name: "upload.png", path: "assets/images/uploads/upload.png", draft: true };
    store.dispatch(draftFromEntry([upload, ALPHA]));
    expect(draftFiles(store)).toEqual(["upload.png", "alpha.png", "beta.png"]);
  });

  test("a draft that already lists the library is dispatched unchanged", () => {
    const { win } = load();
    const action = emptyDraft([ALPHA]);
    expect(win.CMSMediaDraftSync.withLibraryFiles(action, [ALPHA])).toBe(action);
    expect(win.CMSMediaDraftSync.withLibraryFiles(action, [])).toBe(action);
    expect(win.CMSMediaDraftSync.withLibraryFiles({ type: "DRAFT_CREATE_EMPTY" }, [ALPHA]).payload).toBeUndefined();
  });

  test("no library load in play, or an external media library: untouched and not held", () => {
    const { win } = load();
    const idle = decapStore(win);
    idle.dispatch(emptyDraft());
    expect(draftFiles(idle)).toEqual([]);

    const external = decapStore(load().win);
    external.dispatch({ type: "MEDIA_LIBRARY_CREATE", payload: { show() {} } });
    external.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    external.dispatch(emptyDraft());
    expect(draftFiles(external)).toEqual([]);
  });

  test("a held draft is dropped on DRAFT_DISCARD and replaced by a newer one", () => {
    const { win } = load();
    const store = decapStore(win);
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(emptyDraft());
    store.dispatch({ type: "DRAFT_DISCARD" });
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA] } });
    expect(draftFiles(store), "the editor left; nothing is resurrected").toBeNull();

    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(emptyDraft());
    store.dispatch(draftFromEntry());
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA] } });
    expect(store.getState().entryDraft.get("entry").slug).toBe("hello");
  });

  test("a failed load releases the draft as built", () => {
    const { win } = load();
    const store = decapStore(win);
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(emptyDraft());
    store.dispatch({ type: "MEDIA_LOAD_FAILURE" });
    expect(draftFiles(store)).toEqual([]);
  });

  test("a load that never ends releases the draft at Decap's own 30 s wait", () => {
    const { win, timers, fire } = load();
    const store = decapStore(win);
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(emptyDraft());
    expect(timers.map((t) => t.ms)).toEqual([30000]);
    expect(draftFiles(store)).toBeNull();
    fire();
    expect(draftFiles(store)).toEqual([]);
  });

  test("a release cancels its timer, so the draft is dispatched once", () => {
    const { win, timers, fire } = load();
    const store = decapStore(win);
    const seen = [];
    store.subscribe(() => seen.push(store.getState().entryDraft.get("entry")));
    store.dispatch({ type: "MEDIA_LOAD_REQUEST" });
    store.dispatch(emptyDraft());
    store.dispatch({ type: "MEDIA_LOAD_SUCCESS", payload: { files: [ALPHA] } });
    expect(timers[0].cancelled).toBe(true);
    fire();
    expect(seen.filter(Boolean), "the released draft is the only draft dispatched").toHaveLength(1);
  });

  test("other actions and thunks pass straight through", () => {
    const { win } = load();
    const store = decapStore(win);
    const plain = { type: "DRAFT_CHANGE_FIELD", payload: {} };
    expect(store.dispatch(plain)).toBe(plain);
    expect(store.dispatch(() => 42)).toBe(42);
  });
});

// ── Where it loads ─────────────────────────────────────────────────────

function scriptTag(html, src) {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<script\\s+src="${escaped}"([^>]*)>\\s*</script>`).exec(html);
  return m ? { index: m.index, defer: /\bdefer\b/.test(m[1]) } : null;
}

test.describe("media-library-draft-sync.js load order", () => {
  for (const shell of ["index.html", "index-local.html", "index-test.html"]) {
    test(`theme/admin/${shell} loads it non-deferred, before decap-cms.js`, () => {
      const html = fs.readFileSync(path.join(ADMIN, shell), "utf8");
      const decap = /<script\s+src="https:\/\/unpkg\.com\/decap-cms@[^"']+"[^>]*>/.exec(html);
      expect(decap, `${shell} loads the decap-cms bundle`).not.toBeNull();
      const tag = scriptTag(html, "media-library-draft-sync.js");
      expect(tag, `${shell} must load media-library-draft-sync.js`).not.toBeNull();
      expect(tag.defer, "Decap reads the compose hook when its bundle runs, so it must not be deferred").toBe(false);
      expect(tag.index).toBeLessThan(decap.index);
    });
  }
});
