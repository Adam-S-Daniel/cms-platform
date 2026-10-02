/* Shared, public-DOM site identity for admin copy. */
(function () {
  "use strict";

  var TOKEN = "{{CMS_CURRENT_HOST}}";
  var OWNED_CONTROL_SELECTORS = ['[class*="ControlHint"]', '[class*="FieldLabel"]'];

  function hostname(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    try {
      return new URL(String(value || ""), window.location.href).hostname || null;
    } catch (e) {
      return null;
    }
  }

  // On the separate admin origin (`cms.admin_origin`, #517) this tab is the
  // editor, not the site: public URLs and "on <host>" copy come from the
  // configured site origin. Everywhere else (the site's own origin, a
  // preview-prN admin) the tab's origin IS the site it edits.
  function onAdminOrigin() {
    return Boolean(window.CMS_ADMIN_ORIGIN) && window.CMS_ADMIN_ORIGIN === window.location.origin;
  }

  function publicOrigin() {
    if (onAdminOrigin() && hostname(window.CMS_SITE_ORIGIN)) {
      return new URL(String(window.CMS_SITE_ORIGIN)).origin;
    }
    return window.location.origin;
  }

  function current() {
    if (onAdminOrigin() && hostname(window.CMS_SITE_ORIGIN)) return hostname(window.CMS_SITE_ORIGIN);
    return window.location.hostname || hostname(window.location.href) || "this address";
  }

  function canonical() {
    return hostname(window.CMS_SITE_ORIGIN) || hostname("https://" + (window.CMS_APEX || "")) || current();
  }

  function options() {
    return { currentHostname: current(), canonicalHostname: canonical() };
  }

  function ownedControlFor(node) {
    if (!node || !node.closest) return null;
    for (var i = 0; i < OWNED_CONTROL_SELECTORS.length; i += 1) {
      var control = node.closest(OWNED_CONTROL_SELECTORS[i]);
      if (control) return control;
    }
    return null;
  }

  function replaceOwnedControlTokens(root) {
    if (!root || !root.querySelectorAll) return;
    var controls = [];
    OWNED_CONTROL_SELECTORS.forEach(function (selector) {
      if (root.matches && root.matches(selector)) controls.push(root);
      Array.prototype.push.apply(controls, root.querySelectorAll(selector));
    });
    controls.forEach(function (control) {
      var walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.indexOf(TOKEN) !== -1) {
          node.nodeValue = node.nodeValue.split(TOKEN).join(current());
        }
      }
    });
  }

  function localize(root) {
    replaceOwnedControlTokens(root);
  }

  window.CMSHostname = {
    current: current,
    canonical: canonical,
    publicOrigin: publicOrigin,
    fromURL: hostname,
    options: options,
  };

  function start() {
    localize(document.body);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === "characterData" && record.target.parentElement) {
          var changedControl = ownedControlFor(record.target.parentElement);
          if (changedControl) replaceOwnedControlTokens(changedControl);
        }
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node.nodeType === 1) localize(node);
          if (node.nodeType === 3 && node.parentElement) {
            var control = ownedControlFor(node.parentElement);
            if (control) replaceOwnedControlTokens(control);
          }
        });
      });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
