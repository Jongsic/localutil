// Runs synchronously in <head>, before the stylesheet paints, so the saved
// theme is applied without a dark/light flash when navigating between pages.
(function () {
    try {
        var t = localStorage.getItem('localutil-theme');
        if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', t);
    } catch (e) { /* leave the markup default */ }
})();
