/*
 * admin/media-library-draft-sync.js — the image picker lists the media
 * library even when the editor is the first screen the tab loads
 * (cms-platform#647).
 *
 * ── The defect (upstream Decap, decap-cms-core 3.17.1 in the 3.15.1 bundle) ──
 * Inside the editor, the picker does not list the media library. It lists
 * the DRAFT's own copy of it: `selectMediaFiles` (reducers/mediaLibrary.ts)
 * returns `entryDraft.entry.mediaFiles` whenever an entry is being edited,
 * and `Backend.processEntry` (backend.ts) fills that list from
 * `state.mediaLibrary.files` when the collection sets no media_folder of its
 * own — true of every collection on this platform. Both draft builders read
 * that state too early:
 *   - `createEmptyDraft` (actions/entries.ts, the `/new` route) captures
 *     `getState()` BEFORE `await waitForMediaLibraryToLoad(...)` and passes
 *     that stale state to processEntry;
 *   - `loadUnpublishedEntry` (actions/editorialWorkflow.ts, every entry route
 *     under editorial_workflow) never waits at all.
 * The media library is loaded by `<MediaLibrary>`'s componentDidMount, a
 * sibling rendered AFTER the route's `<Editor>` in App.js, so on a tab whose
 * first route is the editor the snapshot is taken before the load starts and
 * the draft keeps an empty list: "No images found". From the collection list
 * the load has long finished, so the same picker is full. Re-loading the
 * library when the picker opens would not help: the picker never reads it.
 *
 * ── What this does ────────────────────────────────────────────────────
 * It makes those two builders behave the way Decap's own `loadEntry` does:
 * a draft is created only once the media library has loaded, from the
 * loaded list. A draft-creating action (DRAFT_CREATE_EMPTY,
 * DRAFT_CREATE_FROM_ENTRY) that arrives
 *   - while the library is loading is held until MEDIA_LOAD_SUCCESS or
 *     MEDIA_LOAD_FAILURE (or HOLD_TIMEOUT_MS, Decap's own wait timeout), then
 *     released with the library's files added;
 *   - after the library has loaded gets any library file it lacks added;
 *   - when no internal library load is in play (an external media library,
 *     or nothing loading) passes through untouched.
 * Files are matched by path, so a draft built from fresh state, or one
 * carrying its own draft uploads, is unchanged. A held draft is dropped when
 * the editor discards it (DRAFT_DISCARD) or a newer draft replaces it.
 *
 * ── How it reaches Decap ──────────────────────────────────────────────
 * Decap builds its store with redux-devtools-extension's
 * `composeWithDevTools(applyMiddleware(thunk, waitUntilAction))`, which uses
 * `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` when it is defined at bundle
 * load. This file defines it (chaining to a real Redux DevTools extension if
 * one is installed) and wraps the base store's dispatch, the `next` of
 * Decap's last middleware, so every plain action a thunk dispatches passes
 * through it. Hence it loads NON-deferred, BEFORE decap-cms.js, in all three
 * admin shells (the publish-via-auto-merge.js idiom). It reads only the
 * action types and the `mediaLibrary` state keys named above. If a future
 * bundle stops consulting the global, nothing here runs and Decap behaves as
 * before.
 *
 * Exposed as window.CMSMediaDraftSync for e2e/media-library-draft-sync.test.js.
 */
(function () {
  "use strict";

  var HOLD_TIMEOUT_MS = 30000;
  var DRAFT_CREATE_EMPTY = "DRAFT_CREATE_EMPTY";
  var DRAFT_CREATE_FROM_ENTRY = "DRAFT_CREATE_FROM_ENTRY";
  var DRAFT_DISCARD = "DRAFT_DISCARD";
  var MEDIA_LOAD_SUCCESS = "MEDIA_LOAD_SUCCESS";
  var MEDIA_LOAD_FAILURE = "MEDIA_LOAD_FAILURE";

  function isDraftCreate(action) {
    return action.type === DRAFT_CREATE_EMPTY || action.type === DRAFT_CREATE_FROM_ENTRY;
  }

  // The entry a draft-creating action carries: DRAFT_CREATE_EMPTY's payload
  // is the entry, DRAFT_CREATE_FROM_ENTRY's is { entry }.
  function entryOf(action) {
    var p = action && action.payload;
    if (!p || typeof p !== "object") return null;
    return action.type === DRAFT_CREATE_EMPTY ? p : p.entry && typeof p.entry === "object" ? p.entry : null;
  }

  // The action with every library file its entry lacks (by path) appended to
  // entry.mediaFiles, as processEntry would have; the same action when there
  // is nothing to add or the shape is not the one expected.
  function withLibraryFiles(action, files) {
    var entry = entryOf(action);
    if (!entry || !Array.isArray(entry.mediaFiles) || !Array.isArray(files) || !files.length) return action;
    var seen = {};
    entry.mediaFiles.forEach(function (f) {
      if (f && f.path) seen[f.path] = true;
    });
    var missing = files.filter(function (f) {
      return f && f.path && !seen[f.path];
    });
    if (!missing.length) return action;
    var nextEntry = Object.assign({}, entry, { mediaFiles: entry.mediaFiles.concat(missing) });
    var payload = action.type === DRAFT_CREATE_EMPTY ? nextEntry : Object.assign({}, action.payload, { entry: nextEntry });
    return Object.assign({}, action, { payload: payload });
  }

  // { isLoading, files, external } from Decap's Immutable `mediaLibrary`
  // state, or null when the state is not shaped that way.
  function libraryState(state) {
    var ml = state && state.mediaLibrary;
    if (!ml || typeof ml.get !== "function") return null;
    return {
      isLoading: ml.get("isLoading"),
      files: ml.get("files"),
      external: !!ml.get("externalLibrary"),
    };
  }

  // Wraps a store's base dispatch. `schedule(fn, ms)` returns a handle for
  // `cancel(handle)`; both default to the window timers.
  function createInterceptor(getState, schedule, cancel) {
    var held = null;
    var timer = null;

    function clearHeld() {
      held = null;
      if (timer !== null && cancel) cancel(timer);
      timer = null;
    }

    return function (next) {
      function release() {
        if (!held) return;
        var action = held;
        clearHeld();
        var lib = libraryState(getState());
        next(withLibraryFiles(action, lib && lib.files));
      }

      return function (action) {
        if (!action || typeof action !== "object" || typeof action.type !== "string") return next(action);

        if (isDraftCreate(action)) {
          clearHeld();
          var lib = libraryState(getState());
          if (!lib || lib.external) return next(action);
          if (lib.isLoading === true) {
            held = action;
            timer = schedule ? schedule(release, HOLD_TIMEOUT_MS) : null;
            return action;
          }
          if (lib.isLoading === false) return next(withLibraryFiles(action, lib.files));
          return next(action);
        }

        if (action.type === DRAFT_DISCARD) {
          clearHeld();
          return next(action);
        }

        if (action.type === MEDIA_LOAD_SUCCESS || action.type === MEDIA_LOAD_FAILURE) {
          var result = next(action);
          release();
          return result;
        }

        return next(action);
      };
    };
  }

  function identity(x) {
    return x;
  }

  // Redux's compose(), so this file needs no redux of its own.
  function composeAll(fns) {
    if (!fns.length) return identity;
    return fns.reduce(function (a, b) {
      return function () {
        return a(b.apply(null, arguments));
      };
    });
  }

  // A store enhancer's inner createStore, with the interceptor on dispatch.
  function wrapCreateStore(createStore, timers) {
    return function () {
      var store = createStore.apply(null, arguments);
      var dispatch = createInterceptor(store.getState, timers.schedule, timers.cancel)(store.dispatch);
      return Object.assign({}, store, { dispatch: dispatch });
    };
  }

  // Defines win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ with the
  // composeWithDevTools contract: called with enhancers it returns one
  // enhancer; called with an options object it returns such a compose.
  function install(win, timers) {
    if (!win || win.__mediaLibraryDraftSyncInstalled) return false;
    win.__mediaLibraryDraftSyncInstalled = true;
    var t = timers || {
      schedule: function (fn, ms) {
        return win.setTimeout(fn, ms);
      },
      cancel: function (h) {
        win.clearTimeout(h);
      },
    };
    var prior = typeof win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ === "function" ? win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ : null;

    function enhancerFrom(priorCompose, enhancers) {
      var outer = priorCompose ? priorCompose.apply(null, enhancers) : composeAll(enhancers);
      return function (createStore) {
        return outer(wrapCreateStore(createStore, t));
      };
    }

    win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length === 1 && args[0] && typeof args[0] === "object") {
        var priorWithOptions = prior ? prior(args[0]) : null;
        return function () {
          return enhancerFrom(priorWithOptions, Array.prototype.slice.call(arguments));
        };
      }
      return enhancerFrom(prior, args);
    };
    return true;
  }

  var api = {
    HOLD_TIMEOUT_MS: HOLD_TIMEOUT_MS,
    withLibraryFiles: withLibraryFiles,
    createInterceptor: createInterceptor,
    install: install,
  };

  if (typeof window === "undefined") return;
  window.CMSMediaDraftSync = api;
  install(window);
})();
