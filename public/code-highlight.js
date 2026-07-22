// Colorized output pane, backed by PrismJS (vendor/prism.min.js — load it first).
// CSP-safe (no eval, no external resources). Exposed as window.LocalUtilHighlight.
(function () {
    'use strict';

    // Above this size, skip coloring and fall back to the plain textarea.
    var MAX_HIGHLIGHT_LEN = 400000;

    // Returns highlighted HTML, or null to fall back to the plain textarea
    // (input too large, or Prism failed to load).
    function highlightJS(code) {
        if (code.length > MAX_HIGHLIGHT_LEN) return null;
        if (!window.Prism || !Prism.languages || !Prism.languages.javascript) return null;
        return Prism.highlight(code, Prism.languages.javascript, 'javascript');
    }

    // Pairs a readonly output <textarea> with a colorized <pre> twin, switched by a
    // checkbox. The textarea keeps holding the raw value so copy buttons keep working.
    // Returns { set(text), refresh() } — use set() instead of writing textarea.value.
    function attachColorizedOutput(textarea, toggle) {
        var view = document.createElement('pre');
        view.className = 'code-view';
        view.style.display = 'none';
        textarea.insertAdjacentElement('afterend', view);

        function refresh() {
            var html = (toggle.checked && textarea.value) ? highlightJS(textarea.value) : null;
            if (html === null) {
                // Carry the user-resized height across the swap
                if (view.style.display !== 'none' && view.offsetHeight) {
                    textarea.style.height = view.offsetHeight + 'px';
                }
                view.style.display = 'none';
                textarea.style.display = '';
            } else {
                if (textarea.style.display !== 'none' && textarea.offsetHeight) {
                    view.style.height = textarea.offsetHeight + 'px';
                }
                view.innerHTML = html;
                textarea.style.display = 'none';
                view.style.display = '';
            }
        }

        toggle.addEventListener('change', refresh);

        return {
            set: function (text) {
                textarea.value = text;
                refresh();
            },
            refresh: refresh
        };
    }

    window.LocalUtilHighlight = {
        highlightJS: highlightJS,
        attachColorizedOutput: attachColorizedOutput
    };
})();
