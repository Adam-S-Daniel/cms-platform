/* Keep Decap's top-right toasts below the in-flow branch and site-gate
 * notices. Their height changes with viewport width and translated copy, so
 * a fixed offset can put "Entry saved" over the coming-soon message. */
(function () {
  "use strict";

  var ids = ["cms-branch-binding-banner", "cms-site-gate-banner"];
  var prop = "--cms-admin-notice-bottom";

  function sync() {
    if (!document.body || !document.body.style) return;
    var bottom = 0;
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el || typeof el.getBoundingClientRect !== "function") continue;
      var edge = el.getBoundingClientRect().bottom;
      if (typeof edge === "number" && isFinite(edge)) bottom = Math.max(bottom, edge);
    }
    var value = bottom ? Math.ceil(bottom) + "px" : "";
    if (document.body.style.getPropertyValue(prop) === value) return;
    if (value) document.body.style.setProperty(prop, value);
    else document.body.style.removeProperty(prop);
  }

  try {
    new MutationObserver(sync).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, { capture: true, passive: true });
    sync();
  } catch {
    /* Leave Decap's default placement if its DOM surface changes. */
  }
})();
