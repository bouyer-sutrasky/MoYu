/* Applies the saved palette before the React shell paints. Kept external so the
 * production Content-Security-Policy can stay script-src 'self'. */
(function () {
  try {
    var mode = localStorage.getItem('moyu.theme') || 'system';
    var dark =
      mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) {
      document.body.setAttribute('data-ds-dark-theme', '');
    } else {
      document.body.removeAttribute('data-ds-dark-theme');
    }
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = mode;
  } catch {
    /* Storage can be unavailable; the React shell still applies the default. */
  }
})();
