// Runs in the page's own JavaScript world so it can see window.dataLayer and document.cookie.
// It only observes: it never changes what the page sends.
(() => {
  if (window.__tcaInstalled) return;
  window.__tcaInstalled = true;

  const send = (type, data) => {
    try { window.postMessage({ __tca: true, type, data, t: Date.now() }, '*'); } catch (e) {}
  };

  const safe = (v, d = 0) => {
    if (d > 3) return '…';
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? '[fn]' : v;
    if (typeof Element !== 'undefined' && v instanceof Element) return '[element]';
    if (Array.isArray(v)) return v.slice(0, 20).map(x => safe(x, d + 1));
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) {
      try { o[k] = safe(v[k], d + 1); } catch (e) { o[k] = '?'; }
    }
    return o;
  };

  const isArgs = e => Object.prototype.toString.call(e) === '[object Arguments]';
  const seen = new WeakSet();
  const handle = entry => {
    if (entry && typeof entry === 'object') {
      if (seen.has(entry)) return;
      seen.add(entry);
    }
    send('dl', isArgs(entry) ? { args: Array.from(entry).map(x => safe(x)) } : { obj: safe(entry) });
  };

  const hook = dl => {
    if (!Array.isArray(dl)) return;
    dl.forEach(handle);
    if (dl.__tcaHooked) return;
    try {
      Object.defineProperty(dl, '__tcaHooked', { value: true });
      const orig = dl.push;
      dl.push = function (...items) { items.forEach(handle); return orig.apply(this, items); };
    } catch (e) {}
  };

  // Catch dataLayer even if the page creates it after we start.
  let _dl = window.dataLayer;
  hook(_dl);
  try {
    Object.defineProperty(window, 'dataLayer', {
      configurable: true, enumerable: true,
      get() { return _dl; },
      set(v) { _dl = v; hook(v); }
    });
  } catch (e) {}

  const cookieSeen = {};
  let firstScan = true;
  const scanCookies = () => {
    let raw = '';
    try { raw = document.cookie; } catch (e) { return; }
    raw.split(';').forEach(c => {
      const n = c.split('=')[0].trim();
      if (n && !cookieSeen[n]) { cookieSeen[n] = 1; send('cookie', { name: n, existing: firstScan }); }
    });
    firstScan = false;
  };

  let lastIds = '';
  const scanIds = () => {
    try {
      const ids = Object.keys(window.google_tag_manager || {}).filter(k => /^(GTM|G|AW|DC|GT)-/.test(k));
      const key = ids.join(',');
      if (key !== lastIds) { lastIds = key; send('ids', ids); }
    } catch (e) {}
  };

  const tick = () => { scanCookies(); hook(window.dataLayer); scanIds(); };
  send('start', { url: location.href });
  tick();
  // Fast polling while the page loads, then slower so consent clicks later on are still caught.
  let n = 0;
  const fast = setInterval(() => { tick(); if (++n > 80) { clearInterval(fast); setInterval(tick, 1500); } }, 250);
})();
