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

  // Watch a data layer by name, and catch it even if the page creates or replaces it after we start.
  const watched = {};
  const watch = name => {
    if (watched[name] || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
    watched[name] = true;
    let cur = window[name];
    hook(cur);
    try {
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true,
        get() { return cur; },
        set(v) { cur = v; hook(v); }
      });
    } catch (e) {}
  };
  watch('dataLayer');

  // Containers can use a custom data layer name, passed as &l=name on the gtm.js / gtag/js URL.
  const fromScript = el => {
    try {
      const src = el.src || '';
      if (!/\/gtm\.js|\/gtag\/js/.test(src)) return;
      const name = new URL(src, location.href).searchParams.get('l');
      if (name) watch(name);
    } catch (e) {}
  };
  const scanLayers = () => {
    try { document.querySelectorAll('script[src*="/gtm.js"],script[src*="/gtag/js"]').forEach(fromScript); } catch (e) {}
  };
  // Spot the script tag the moment it is added, so entries get accurate timestamps.
  let observer = null;
  try {
    observer = new MutationObserver(list => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeName === 'SCRIPT') fromScript(n);
    });
    observer.observe(document, { childList: true, subtree: true });
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

  const tick = () => { scanCookies(); scanLayers(); Object.keys(watched).forEach(n => { try { hook(window[n]); } catch (e) {} }); scanIds(); };
  send('start', { url: location.href });
  tick();
  // Fast polling while the page loads, then slower so consent clicks later on are still caught.
  let n = 0;
  const fast = setInterval(() => { tick(); if (++n > 80) { clearInterval(fast); if (observer) observer.disconnect(); setInterval(tick, 1500); } }, 250);
})();
