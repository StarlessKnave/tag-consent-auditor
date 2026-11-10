// Applies the saved theme before first paint (falls back to the system setting).
(function () {
  const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = localStorage.getItem('tca-theme') || sys;
})();
