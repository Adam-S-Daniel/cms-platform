/*
 * Decap 3.15.1 leaves CodeControl.isLangInitialized false when a new Code
 * Block has no language. Its first Mode selection is then mistaken for
 * initialization and never sent to onChange, so Markdown loses the language
 * (#732). Keep the stock widget and serializer; initialize that flag for an
 * empty-language editor component after the stock mount has run.
 *
 * Replace only the control, preserving the preview, schema, allowMapValue and
 * CodeMirror options. Standalone code fields are unchanged.
 */
(function () {
  "use strict";

  var REGISTER_TIMEOUT_MS = 30_000;
  var POLL_INTERVAL_MS = 100;

  function tryRegister() {
    var cms = window.CMS;
    if (!cms || typeof cms.getWidget !== "function" || typeof cms.registerWidget !== "function") return false;
    var widget = cms.getWidget("code");
    if (!widget || !widget.control) return false;
    var StockControl = widget.control;
    class CodeBlockControl extends StockControl {
      componentDidMount() {
        super.componentDidMount();
        if (this.props.isEditorComponent && !this.getInitialLang()) {
          this.setState({ isLangInitialized: true });
        }
      }
    }
    // Swap the control on the registered widget itself when the registry
    // hands out its live entry (it does in 3.17.3): registering "code" a
    // second time works but logs "Multiple widgets registered with name
    // "code"" on every admin load. Checked by reading it back; anything else
    // falls through to the public registration below.
    try {
      widget.control = CodeBlockControl;
      if (cms.getWidget("code") === widget && widget.control === CodeBlockControl) return true;
    } catch {
      /* a frozen entry: register instead */
    }
    var registration = Object.assign({}, widget, {
      name: "code",
      controlComponent: CodeBlockControl,
      previewComponent: widget.preview,
    });
    // These are registry output keys. Leaving them in options overwrites
    // controlComponent/previewComponent inside Decap's registerWidget.
    delete registration.control;
    delete registration.preview;
    cms.registerWidget(registration);
    return true;
  }

  function waitForCMS() {
    var start = Date.now();
    function tick() {
      if (tryRegister()) return;
      if (Date.now() - start > REGISTER_TIMEOUT_MS) return;
      setTimeout(tick, POLL_INTERVAL_MS);
    }
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForCMS);
  } else {
    waitForCMS();
  }
})();
