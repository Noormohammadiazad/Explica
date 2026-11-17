// Explica: apply the saved or system colour theme before first paint, so the
// page never flashes the wrong theme. Mirrors resolveTheme() in src/ui/theme.ts.
(function () {
  var root = document.documentElement;
  var t = null;
  try {
    t = localStorage.getItem('explica.theme');
  } catch (e) {
    t = null;
  }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', t);
  // no transitions until the app has painted once
  root.classList.add('preload');
})();
