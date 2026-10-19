// Applies the saved theme before first paint to avoid a flash. Kept external so the CSP can forbid inline scripts.
(function () {
  try {
    var pref = localStorage.getItem('alypne-theme') || 'dark';
    var theme = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
