/*
 * Shared, public-DOM site identity for admin copy.
 *
 * Three hostnames, and they are not interchangeable (#533):
 *
 *   current()     — the ACCESS host: the address this admin tab was opened
 *                   on (or the site's, on the separate admin origin, #517).
 *                   On production that can be `www.`, a CloudFront
 *                   distribution hostname or localhost, none of which is
 *                   where a publish goes.
 *   canonical()   — the PRODUCTION destination, from the injected
 *                   window.CMS_SITE_ORIGIN (then window.CMS_APEX).
 *   destination() — where a publish from THIS admin goes: the host of the
 *                   `site_url` in the config.yml this admin serves. Both
 *                   render paths write the site's `url` there, and
 *                   scripts/patch-preview-config.sh rewrites it to the
 *                   preview host on a preview deploy, so it is the canonical
 *                   host on production (from any access host) and the
 *                   preview host on a preview. The local and test shells'
 *                   configs name http://localhost:4000, so local development
 *                   names localhost — intentionally: there a publish writes
 *                   to the working tree that localhost serves. Until the
 *                   config has been read, or when it cannot be, it is
 *                   current(): right on a preview (where canonical() would
 *                   name production — the confusion this exists to remove),
 *                   and only cosmetically off on a production `www.`.
 *
 * The `{{CMS_CURRENT_HOST}}` token in platform field labels and hints means
 * destination() (it keeps its old name because site-owned config may carry
 * it). It is replaced only once the served config has been read, so a label
 * never shows a guess that later turns out wrong; Decap needs the same config
 * before it can render any field, so in practice the read has settled first.
 * The read is abandoned after CONFIG_READ_TIMEOUT_MS and treated as
 * unreadable, so a stalled connection cannot leave the raw token on screen.
 *
 * destinationOrigin(fallbackOrigin) preserves the HTTP(S) protocol and port
 * of site_url, with paths and credentials removed. Local config
 * http://localhost:4000
 * therefore keeps its local URL. Before the read settles, or if unreadable,
 * it uses fallbackOrigin when provided, otherwise publicOrigin(), including
 * the separate admin origin rule.
 *
 * binding() exposes the same read — `{ branch, destination, destinationOrigin }` — for
 * site-gate-banner.js, which must read its flag at the branch this admin is
 * bound to (#528). The branch is read at the line anchor
 * patch-preview-config.sh writes (`^  branch:`), the same lexical contract as
 * branch-binding-banner.js: a value that is not a plain git ref name is null.
 */
(function () {
  "use strict";

  var TOKEN = "{{CMS_CURRENT_HOST}}";
  var OWNED_CONTROL_SELECTORS = ['[class*="ControlHint"]', '[class*="FieldLabel"]'];
  var DEFAULT_CONFIG_FILE = "config.yml";
  // The characters a plain git ref name is made of (branch-binding-banner.js).
  var REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  var UNKNOWN = { branch: null, destination: null, destinationOrigin: null };
  var CONFIG_READ_TIMEOUT_MS = 10000;

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

  // ── The served config ────────────────────────────────────────────────
  // Lexical reads of two top-level leaves, at the anchors the writers emit;
  // an unmatched or malformed value is null, never a guess.
  function parseServedConfig(text) {
    var src = String(text || "");
    var b = /^ {2}branch:[ \t]*([^\s#]+)[ \t]*(?:#.*)?$/m.exec(src);
    var u = /^site_url:[ \t]*(["']?)([^\s"'#]+)\1[ \t]*(?:#.*)?$/m.exec(src);
    var dest = null;
    var origin = null;
    if (u) {
      try {
        var parsed = new URL(u[2]);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          dest = parsed.hostname || null;
          origin = parsed.origin;
        }
      } catch (e) {
        dest = null;
      }
    }
    return { branch: b && REF_NAME.test(b[1]) ? b[1] : null, destination: dest, destinationOrigin: origin };
  }

  // Decap loads the file a `<link rel="cms-config-url">` names, else
  // config.yml beside the shell; read the same one.
  function configURL() {
    var link = document.querySelector ? document.querySelector('link[rel="cms-config-url"]') : null;
    var href = (link && link.getAttribute("href")) || DEFAULT_CONFIG_FILE;
    return new URL(href, document.baseURI || window.location.href).href;
  }

  var served = null; // settled result of the one read; null until then
  var servedRead = null;

  function binding() {
    if (servedRead) return servedRead;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    var read;
    try {
      read =
        typeof fetch === "function"
          ? fetch(configURL(), { cache: "no-cache", signal: controller ? controller.signal : undefined })
          : Promise.resolve(null);
    } catch (e) {
      read = Promise.resolve(null);
    }
    var text = Promise.resolve(read).then(function (res) {
      return res && res.ok ? res.text() : null;
    });
    // A stalled read counts as unreadable — see the header.
    var timedOut = new Promise(function (resolve) {
      if (typeof setTimeout !== "function") return;
      timer = setTimeout(function () {
        if (controller) controller.abort();
        resolve(null);
      }, CONFIG_READ_TIMEOUT_MS);
    });
    servedRead = Promise.race([text, timedOut])
      .then(function (body) {
        return body === null ? UNKNOWN : parseServedConfig(body);
      })
      .catch(function () {
        return UNKNOWN;
      })
      .then(function (result) {
        if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
        served = result;
        return result;
      });
    return servedRead;
  }

  function destination() {
    return (served && served.destination) || current();
  }

  function destinationOrigin(fallbackOrigin) {
    return (served && served.destinationOrigin) || fallbackOrigin || publicOrigin();
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
    // Hold the token until the served config has settled — see the header.
    if (!served || !root || !root.querySelectorAll) return;
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
          node.nodeValue = node.nodeValue.split(TOKEN).join(destination());
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
    destination: destination,
    destinationOrigin: destinationOrigin,
    binding: binding,
    parseServedConfig: parseServedConfig,
    publicOrigin: publicOrigin,
    fromURL: hostname,
    options: options,
  };

  // Start the read now, before Decap renders a field that needs it.
  binding();

  function start() {
    binding().then(function () {
      localize(document.body);
    });
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
