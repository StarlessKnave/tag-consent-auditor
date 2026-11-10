// Records measurement-related network requests and page observations per tab.
const tabs = {};
const fresh = (url = '', t = Date.now()) => ({ url, started: t, requests: [], dl: [], cookies: {}, ids: [] });

async function getTab(id) {
  if (!tabs[id]) {
    const key = 't' + id;
    const saved = (await chrome.storage.session.get(key))[key];
    if (!tabs[id]) tabs[id] = saved || fresh();
  }
  return tabs[id];
}

const timers = {};
function persist(id) {
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => {
    if (tabs[id]) chrome.storage.session.set({ ['t' + id]: tabs[id] }).catch(() => {});
  }, 300);
}

// ---------- request classification ----------
const CMPS = [
  [/consent\.cookiebot\.(com|eu)/, 'Cookiebot'],
  [/cdn\.cookielaw\.org|onetrust\.com/, 'OneTrust'],
  [/cdn-cookieyes\.com/, 'CookieYes'],
  [/usercentrics\.eu/, 'Usercentrics'],
  [/cmp\.osano\.com/, 'Osano'],
  [/didomi\.io/, 'Didomi'],
  [/iubenda\.com/, 'iubenda'],
  [/termly\.io/, 'Termly'],
  [/quantcast\.mgr\.consensu\.org|cmp\.quantcast\.com/, 'Quantcast Choice']
];

function bodyText(details) {
  try {
    const raw = details.requestBody && details.requestBody.raw;
    if (!raw) return '';
    return raw.map(p => (p.bytes ? new TextDecoder().decode(p.bytes) : '')).join('');
  } catch (e) { return ''; }
}

function idPrefixVendor(id = '') {
  if (id.startsWith('G-')) return 'ga4';
  if (id.startsWith('AW-')) return 'gads';
  if (id.startsWith('GTM-')) return 'gtm';
  return 'gtag';
}

function classify(details) {
  let u;
  try { u = new URL(details.url); } catch (e) { return null; }
  const h = u.hostname, p = u.pathname, q = u.searchParams;

  for (const [re, name] of CMPS) if (re.test(h)) return { vendor: 'cmp', kind: 'load', id: name };

  if (/googletagmanager\.com$/.test(h)) {
    if (p.startsWith('/gtm.js')) return { vendor: 'gtm', kind: 'load', id: q.get('id') || '' };
    if (p.startsWith('/gtag/js')) { const id = q.get('id') || ''; return { vendor: idPrefixVendor(id), kind: 'load', id }; }
  }

  // GA4 hit, including hits routed through a server-side GTM endpoint on any host.
  if (/\/g\/collect$/.test(p) && (q.get('tid') || '').startsWith('G-')) {
    const events = [];
    if (q.get('en')) events.push(q.get('en'));
    bodyText(details).split('\n').forEach(line => {
      const m = line.match(/(?:^|&)en=([^&]+)/);
      if (m) events.push(decodeURIComponent(m[1]));
    });
    return {
      vendor: 'ga4', kind: 'hit', id: q.get('tid'), events,
      gcs: q.get('gcs') || '', gcd: q.get('gcd') || '',
      server: /google-analytics\.com$|analytics\.google\.com$/.test(h) ? '' : h,
      em: q.has('em') || /(?:^|&)em=/.test(bodyText(details))
    };
  }

  // Google Ads conversions and remarketing
  let m = p.match(/\/pagead\/(?:conversion|viewthroughconversion|1p-conversion|1p-user-list)\/(\d+)/);
  if (m && /googleadservices\.com$|doubleclick\.net$|google\.[a-z.]+$/.test(h)) {
    const label = q.get('label') || '';
    return {
      vendor: 'gads', kind: 'hit', id: 'AW-' + m[1], label,
      events: [label ? 'conversion' : 'remarketing'],
      gcs: q.get('gcs') || '', gcd: q.get('gcd') || '',
      em: q.has('em') || (q.get('data') || '').includes('em') || /(?:^|&)em=/.test(bodyText(details))
    };
  }

  if (/(^|\.)facebook\.(com|net)$/.test(h)) {
    if (/^\/tr\/?$/.test(p)) return { vendor: 'meta', kind: 'hit', id: q.get('id') || '', events: [q.get('ev') || 'unknown'] };
    if (/fbevents\.js/.test(p)) return { vendor: 'meta', kind: 'load', id: '' };
  }
  if (h === 'connect.facebook.net' && /fbevents\.js/.test(p)) return { vendor: 'meta', kind: 'load', id: '' };

  if (/px\.ads\.linkedin\.com$/.test(h)) return { vendor: 'linkedin', kind: 'hit', id: q.get('pid') || '', events: [q.get('conversionId') ? 'conversion' : 'page_view'] };
  if (/snap\.licdn\.com$/.test(h) && /insight/.test(p)) return { vendor: 'linkedin', kind: 'load', id: '' };

  if (/bat\.bing\.com$/.test(h)) {
    if (p.startsWith('/action')) return { vendor: 'microsoft', kind: 'hit', id: q.get('ti') || '', events: [q.get('evt') || 'unknown'] };
    if (/bat\.js/.test(p)) return { vendor: 'microsoft', kind: 'load', id: '' };
  }

  if (/analytics\.tiktok\.com$/.test(h)) {
    if (/\/api\/v2\/pixel/.test(p)) return { vendor: 'tiktok', kind: 'hit', id: '', events: ['event'] };
    if (/events\.js/.test(p)) return { vendor: 'tiktok', kind: 'load', id: q.get('sdkid') || '' };
  }

  if (/static\.hotjar\.com$/.test(h)) return { vendor: 'hotjar', kind: 'load', id: q.get('hjid') || '' };
  if (/js\.hs-scripts\.com$|js\.hs-analytics\.net$/.test(h)) return { vendor: 'hubspot', kind: 'load', id: (p.match(/\d+/) || [''])[0] };
  if (/track\.hubspot\.com$/.test(h)) return { vendor: 'hubspot', kind: 'hit', id: q.get('a') || '', events: ['page_view'] };
  if (/clarity\.ms$/.test(h)) return { vendor: 'clarity', kind: /\/collect/.test(p) ? 'hit' : 'load', id: '', events: ['session'] };

  return null;
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const hit = classify(details);
  if (!hit) return;
  getTab(details.tabId).then(() => {
    const s = tabs[details.tabId];
    if (!s || s.requests.length > 500) return;
    s.requests.push({ ...hit, t: details.timeStamp, url: details.url.slice(0, 800) });
    persist(details.tabId);
  });
}, { urls: ['<all_urls>'] }, ['requestBody']);

chrome.webNavigation.onCommitted.addListener(d => {
  if (d.frameId !== 0) return;
  // Start a fresh record, but keep anything that already arrived for this new page.
  const old = tabs[d.tabId];
  const nu = fresh(d.url, d.timeStamp);
  if (old) {
    const cut = d.timeStamp - 100;
    nu.requests = old.requests.filter(r => r.t >= cut);
    nu.dl = old.dl.filter(e => e.t >= cut);
    for (const [k, v] of Object.entries(old.cookies)) if ((v.t ?? v) >= cut) nu.cookies[k] = v;
  }
  tabs[d.tabId] = nu;
  persist(d.tabId);
});

chrome.tabs.onRemoved.addListener(id => {
  delete tabs[id];
  chrome.storage.session.remove('t' + id).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.kind === 'page' && sender.tab) {
    const id = sender.tab.id;
    getTab(id).then(() => {
      const s = tabs[id];
      if (!s) return;
      if (msg.type === 'start') s.url = msg.data.url;
      else if (msg.type === 'dl' && s.dl.length < 400) s.dl.push({ ...msg.data, t: msg.t });
      else if (msg.type === 'cookie' && !(msg.data.name in s.cookies)) s.cookies[msg.data.name] = { t: msg.t, existing: !!msg.data.existing };
      else if (msg.type === 'ids') s.ids = msg.data;
      persist(id);
    });
    return false;
  }
  if (msg.kind === 'getState') {
    getTab(msg.tabId).then(s => reply(s));
    return true;
  }
});
