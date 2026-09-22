/* Shared, public-DOM site identity for admin copy. */
(function () {
  "use strict";

  var TOKEN = "{{CMS_CURRENT_HOST}}";

  function hostname(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    try {
      return new URL(String(value || ""), window.location.href).hostname || null;
    } catch (e) {
      return null;
    }
  }

  function current() {
    return window.location.hostname || hostname(window.location.href) || "this address";
  }

  function canonical() {
    return hostname(window.CMS_SITE_ORIGIN) || hostname("https://" + (window.CMS_APEX || "")) || current();
  }

  function options() {
    return { currentHostname: current(), canonicalHostname: canonical() };
  }

  function replaceOwnedHintTokens(root) {
    if (!root || !root.querySelectorAll) return;
    var controls = [];
    if (root.matches && root.matches('[class*="ControlHint"]')) controls.push(root);
    Array.prototype.push.apply(
      controls,
      root.querySelectorAll('[class*="ControlHint"]'),
    );
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
    replaceOwnedHintTokens(root);
  }

  window.CMSHostname = {
    current: current,
    canonical: canonical,
    fromURL: hostname,
    options: options,
  };

  function start() {
    localize(document.body);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === "characterData" && record.target.parentElement) {
          var changedHint = record.target.parentElement.closest('[class*="ControlHint"]');
          if (changedHint) replaceOwnedHintTokens(changedHint);
        }
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node.nodeType === 1) localize(node);
          if (node.nodeType === 3 && node.parentElement) {
            var hint = node.parentElement.closest('[class*="ControlHint"]');
            if (hint) replaceOwnedHintTokens(hint);
          }
        });
      });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
