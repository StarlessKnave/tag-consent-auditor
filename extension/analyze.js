// Turns raw observations into an audit: detected tags, consent state, checks and a score.
const VENDORS = {
  gtm: 'Google Tag Manager', gtag: 'Google tag', ga4: 'Google Analytics 4', gads: 'Google Ads',
  meta: 'Meta Pixel', linkedin: 'LinkedIn Insight Tag', microsoft: 'Microsoft UET', tiktok: 'TikTok Pixel',
  hotjar: 'Hotjar', hubspot: 'HubSpot', clarity: 'Microsoft Clarity'
};
const NON_GOOGLE_ADS = ['meta', 'linkedin', 'microsoft', 'tiktok'];
// Third entry: which consent signal covers the cookie ('any' = either one is enough).
const TRACKING_COOKIES = [
  [/^_ga($|_)/, 'Google Analytics', 'analytics'], [/^_gid$/, 'Google Analytics', 'analytics'], [/^_gcl_/, 'Google Ads', 'ads'],
  [/^_fbp$|^_fbc$/, 'Meta', 'ads'], [/^_uet(sid|vid)$/, 'Microsoft Ads', 'ads'], [/^MUID$/, 'Microsoft', 'ads'],
  [/^li_fat_id$|^lidc$|^bcookie$/, 'LinkedIn', 'ads'], [/^_ttp$/, 'TikTok', 'ads'], [/^_hj/, 'Hotjar', 'analytics'],
  [/^__hstc$|^hubspotutk$|^__hssc$/, 'HubSpot', 'any'], [/^_clck$|^_clsk$/, 'Microsoft Clarity', 'analytics']
];
const SIGNALS = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
// gcd letters: [state set by default, state set by update]
const GCD = {
  l: [null, null], p: ['denied', null], q: ['denied', 'denied'], t: ['granted', null], r: ['denied', 'granted'],
  m: [null, 'denied'], n: [null, 'granted'], u: ['granted', 'denied'], v: ['granted', 'granted']
};

// Decodes the gcd parameter Google hits carry: the state of all four signals as the tag actually sent them.
function decodeGcd(gcd) {
  const m = /^\d\d([a-z])\d([a-z])\d([a-z])\d([a-z])/.exec(gcd || '');
  if (!m || !m.slice(1).every(c => GCD[c])) return null;
  const out = {};
  SIGNALS.forEach((k, i) => { const [def, update] = GCD[m[i + 1]]; out[k] = { def, update, now: update || def }; });
  return out;
}
const KEY_EVENTS = /^(generate_lead|sign_up|purchase|begin_checkout|add_to_cart|submit_lead_form|form_submit|contact|lead|Lead|Purchase|CompleteRegistration|Contact|Schedule|SubmitApplication)$/;

function gcsLabel(gcs) {
  const m = /^G1([01])([01])$/.exec(gcs || '');
  if (!m) return '';
  return `ads ${m[1] === '1' ? 'granted' : 'denied'}, analytics ${m[2] === '1' ? 'granted' : 'denied'}`;
}

function analyze(s) {
  const reqs = s.requests || [];
  const dl = s.dl || [];

  // ---- consent ----
  const consentCmds = dl.filter(e => e.args && e.args[0] === 'consent')
    .map(e => ({ type: e.args[1], params: e.args[2] && typeof e.args[2] === 'object' ? e.args[2] : {}, t: e.t }));
  const defaults = consentCmds.filter(c => c.type === 'default');
  const updates = consentCmds.filter(c => c.type === 'update');
  const choiceT = updates.length ? updates[0].t : null;
  const grant = updates.find(c => c.params.ad_storage === 'granted' || c.params.analytics_storage === 'granted');
  const grantT = grant ? grant.t : null;
  const cmp = [...new Set(reqs.filter(r => r.vendor === 'cmp').map(r => r.id))];

  // What Google hits actually carried (gcd), oldest first.
  const gcdHits = reqs.filter(r => r.kind === 'hit' && (r.vendor === 'ga4' || r.vendor === 'gads'))
    .map(r => ({ t: r.t, g: decodeGcd(r.gcd), gcs: r.gcs })).sort((a, b) => a.t - b.t);
  const sentHits = gcdHits.filter(h => h.g);
  const sentDefault = sentHits.some(h => SIGNALS.some(k => h.g[k].def));

  // Defaults can be scoped to regions. Pick the one that applies to this visitor: the one matching what
  // the hits sent, or the unscoped default when there is no evidence either way.
  const regionOf = c => (Array.isArray(c.params.region) ? c.params.region : []);
  const strip = p => { const o = { ...p }; delete o.region; return o; };
  const globalParams = Object.assign({}, ...defaults.filter(c => !regionOf(c).length).map(c => strip(c.params)));
  const regionDefs = defaults.filter(c => regionOf(c).length);
  const candidates = [];
  if (defaults.length > regionDefs.length) candidates.push({ params: globalParams, regions: null });
  regionDefs.forEach(c => candidates.push({ params: { ...globalParams, ...strip(c.params) }, regions: regionOf(c) }));
  let def = null, regionEvidence = false;
  if (candidates.length) {
    const seen = {};
    const firstSent = sentHits[0], firstGcs = gcdHits.find(h => /^G1[01][01]$/.test(h.gcs) && (choiceT === null || h.t < choiceT));
    if (firstSent) SIGNALS.forEach(k => { if (firstSent.g[k].def) seen[k] = firstSent.g[k].def; });
    else if (firstGcs) { seen.ad_storage = firstGcs.gcs[2] === '1' ? 'granted' : 'denied'; seen.analytics_storage = firstGcs.gcs[3] === '1' ? 'granted' : 'denied'; }
    const fit = c => Object.keys(seen).reduce((n, k) => n + (c.params[k] === seen[k] ? 1 : c.params[k] ? -1 : 0), 0);
    const best = candidates.reduce((a, c) => (fit(c) > fit(a) ? c : a));
    regionEvidence = regionDefs.length > 0 && candidates.some(c => fit(c) !== fit(best));
    def = { type: 'default', params: best.params, regions: best.regions, t: Math.min(...defaults.map(c => c.t)) };
  }
  const deniedByDefault = !!def && ['ad_storage', 'analytics_storage'].some(k => def.params[k] === 'denied');

  // Consent is a state that changes over time: a grant can cover one signal only, and can be withdrawn.
  const stateAt = t => {
    const st = def ? { ...def.params } : {};
    for (const u of updates) if (u.t <= t) Object.assign(st, u.params);
    return st;
  };
  const adsOk = t => stateAt(t).ad_storage === 'granted';
  const analyticsOk = t => stateAt(t).analytics_storage === 'granted';
  const now = stateAt(Infinity);
  const afterChoice = t => choiceT !== null && t >= choiceT;

  // Single-page apps: each route change starts a new virtual page.
  const navs = (s.navs || []).map(n => n.t).sort((a, b) => a - b);
  const routeOf = t => navs.filter(n => n <= t + 50).length;

  // ---- tags ----
  const tags = {};
  for (const r of reqs) {
    if (r.vendor === 'cmp') continue;
    const key = r.vendor + '|' + (r.id || '');
    const tg = tags[key] || (tags[key] = { vendor: r.vendor, name: VENDORS[r.vendor] || r.vendor, id: r.id, loaded: false, hits: 0, events: {}, firstT: r.t, server: '', em: false, gcs: new Set() });
    tg.firstT = Math.min(tg.firstT, r.t);
    if (r.kind === 'load') tg.loaded = true;
    if (r.kind === 'hit') {
      tg.hits++;
      (r.events || []).forEach(e => { tg.events[e] = (tg.events[e] || 0) + 1; });
      if (r.server) tg.server = r.server;
      if (r.em) tg.em = true;
      if (r.gcs) tg.gcs.add(r.gcs);
    }
  }
  // Fold "load only, no id" entries into a vendor's hit entry so we don't report the same pixel twice.
  for (const k of Object.keys(tags)) {
    const tg = tags[k];
    if (!tg.id && tg.hits === 0) {
      const sib = Object.values(tags).find(o => o !== tg && o.vendor === tg.vendor && o.hits > 0);
      if (sib) { sib.loaded = true; delete tags[k]; }
    }
  }
  const tagList = Object.values(tags).sort((a, b) => a.firstT - b.firstT);
  const ga4 = tagList.filter(t => t.vendor === 'ga4');
  const gads = tagList.filter(t => t.vendor === 'gads');
  const gtm = tagList.filter(t => t.vendor === 'gtm');
  const googleReqs = reqs.filter(r => ['gtm', 'gtag', 'ga4', 'gads'].includes(r.vendor));
  const anyMarketing = tagList.some(t => [...NON_GOOGLE_ADS, 'gads', 'ga4', 'hotjar', 'hubspot', 'clarity'].includes(t.vendor));

  // ---- events ----
  const dlEvents = dl.filter(e => e.obj && typeof e.obj.event === 'string').map(e => ({ name: e.obj.event, t: e.t, source: 'dataLayer' }))
    .concat(dl.filter(e => e.args && e.args[0] === 'event').map(e => ({ name: e.args[1], t: e.t, source: 'gtag' })));
  const hitEvents = reqs.filter(r => r.kind === 'hit').flatMap(r => (r.events || []).map(n => ({ name: n, t: r.t, source: VENDORS[r.vendor] + (r.id ? ' ' + r.id : '') })));
  // Ad platforms report conversions as a generic 'conversion' hit, so name them by vendor.
  const convHits = reqs.filter(r => r.kind === 'hit' && (r.events || []).includes('conversion'))
    .map(r => `${VENDORS[r.vendor]} conversion${r.id ? ' (' + r.id + ')' : ''}`);
  const keyEvents = [...new Set(dlEvents.concat(hitEvents).map(e => e.name).filter(n => KEY_EVENTS.test(n)).concat(convHits))];

  // ---- cookies ----
  const cookies = Object.entries(s.cookies || {}).map(([name, v]) => {
    const match = TRACKING_COOKIES.find(([re]) => re.test(name));
    const t = typeof v === 'number' ? v : v.t;
    return { name, t, existing: !!(v && v.existing), owner: match ? match[1] : null, needs: match ? match[2] : null, early: false };
  }).sort((a, b) => a.t - b.t);
  const trackingCookies = cookies.filter(c => c.owner);
  const cookieOk = c => c.needs === 'ads' ? adsOk(c.t) : c.needs === 'analytics' ? analyticsOk(c.t) : adsOk(c.t) || analyticsOk(c.t);

  // ---- checks ----
  const checks = [];
  const add = (sev, title, detail, fix) => checks.push({ sev, title, detail, fix });

  // Tag management
  if (gtm.length === 1) add('pass', 'Google Tag Manager detected', `Container ${gtm[0].id || ''} is loading.`);
  else if (gtm.length > 1) add('warn', `${gtm.length} GTM containers on one page`, gtm.map(t => t.id).join(', '), 'Several containers make tags harder to govern and can double-fire them. Check each one is needed.');
  else if (tagList.length) add('info', 'No Google Tag Manager', 'Tags are hard-coded or loaded another way.', 'Managing tags in one GTM container makes consent, naming and QA much easier.');

  // GA4
  if (!ga4.length) add('info', 'No Google Analytics 4 detected', 'No GA4 hits or gtag.js loads were seen.');
  for (const g of ga4) {
    if (g.hits === 0) add('warn', `GA4 ${g.id} loads but sends nothing`, 'The library loaded but no hits were sent.', deniedByDefault ? 'If you use Basic Consent Mode this is expected until consent is given. Otherwise check the config tag fires.' : 'Check the GA4 config tag fires on page load.');
    else {
      const pv = g.events.page_view || 0;
      // Count page views per route, so a single-page app sending one per route change is not a duplicate.
      const perRoute = {};
      reqs.filter(r => r.vendor === 'ga4' && r.id === g.id && r.kind === 'hit').forEach(r => {
        const n = (r.events || []).filter(e => e === 'page_view').length;
        if (n) perRoute[routeOf(r.t)] = (perRoute[routeOf(r.t)] || 0) + n;
      });
      const worst = Math.max(0, ...Object.values(perRoute));
      const hitsTxt = `${g.hits} hit${g.hits > 1 ? 's' : ''} sent`;
      if (worst > 1) add('warn', `GA4 ${g.id} sent page_view ${worst} times${navs.length ? ' for one route' : ''}`, 'Duplicate page views inflate sessions and distort engagement metrics.', 'Look for the config tag firing twice, or gtag.js and GTM both sending page views.' + (navs.length ? ' Route changes in this single-page app are already counted separately.' : ''));
      else if (pv === 1) add('pass', `GA4 ${g.id} is firing`, `${hitsTxt}, including one page_view.`);
      else if (pv > 1) add('pass', `GA4 ${g.id} is firing`, `${hitsTxt}, including ${pv} page_views across ${navs.length} route change${navs.length > 1 ? 's' : ''} (single-page app).`);
      else add('warn', `GA4 ${g.id} sent no page_view`, `${g.hits} hit${g.hits > 1 ? 's' : ''} but no page_view.`, 'Check send_page_view is not disabled and the config tag fires on all pages.');
    }
    if (g.server) add('pass', 'Server-side tagging in use', `GA4 hits go through ${g.server}, a first-party endpoint.`);
  }
  if (ga4.length > 1) add('info', `${ga4.length} GA4 properties on one page`, ga4.map(g => g.id).join(', '), 'Fine if intentional (e.g. a roll-up property). Otherwise remove the extra one.');

  // Consent Mode
  const hasGoogle = googleReqs.length > 0;
  if (hasGoogle) {
    if (!def) {
      const gcsSeen = reqs.some(r => r.gcs);
      const sentUpdate = sentHits.some(h => SIGNALS.some(k => h.g[k].update));
      if (sentDefault) add('pass', 'Consent default is set', 'Google hits confirm a consent default is applied, although the command itself was not seen in the dataLayer.');
      else if (sentUpdate) add('warn', 'Consent updates sent without a default', 'Google hits carry a consent choice, but no default state was set before it.', 'Set consent defaults with gtag(\'consent\', \'default\', …) before any Google tag runs.');
      else if (sentHits.length) add('fail', 'Consent Mode not implemented', 'Google hits carry no consent state for any of the four signals.', 'Google requires Consent Mode v2 for UK and EEA traffic to keep ad personalisation and measurement. Set defaults through your CMP or a GTM consent template.');
      else if (gcsSeen) add('warn', 'Consent signals sent without a visible default', 'Google hits carry consent state, but no consent default command was seen in the dataLayer.', 'Set consent defaults with gtag(\'consent\', \'default\', …) before any Google tag runs.');
      else add('fail', 'Consent Mode not implemented', 'Google tags fire with no consent default.', 'Google requires Consent Mode v2 for UK and EEA traffic to keep ad personalisation and measurement. Set defaults through your CMP or a GTM consent template.');
    } else {
      const states = SIGNALS.map(k => `${k}: ${def.params[k] || '—'}`).join(' · ');
      add('pass', 'Consent default is set', states);
      if (regionDefs.length) {
        const all = [...new Set(regionDefs.flatMap(regionOf))];
        const list = all.slice(0, 8).join(', ') + (all.length > 8 ? '…' : '');
        add('info', 'Consent defaults differ by region', `Region-specific defaults are set for ${list}. This audit uses ${def.regions ? 'the default for ' + def.regions.slice(0, 8).join(', ') : 'the default for all other regions'}${regionEvidence ? ', which matches what Google hits sent from this browser' : ', as nothing sent so far shows which one applies here'}. To audit another region, browse from that location (e.g. through a VPN).`);
        if (candidates.every(c => c.regions)) add('info', 'No consent default outside the listed regions', 'Visitors elsewhere get no default, so Google treats every signal as granted.', 'Fine if intentional. Otherwise add an unscoped default as a fallback.');
      }
      const missing = ['ad_user_data', 'ad_personalization'].filter(k => !(k in def.params));
      if (missing.length) add('warn', 'Consent Mode v2 signals missing', `Default doesn't set ${missing.join(' and ')}.`, 'Add both v2 parameters to the default and update commands, or Google Ads audiences and conversions will be limited.');
      else {
        // The dataLayer looks right; confirm the hits themselves carry the v2 signals.
        const lastSent = sentHits.filter(h => h.t > def.t).pop();
        const dropped = lastSent && lastSent.g.ad_storage.now ? ['ad_user_data', 'ad_personalization'].filter(k => !lastSent.g[k].now) : [];
        if (dropped.length) add('warn', 'Consent Mode v2 signals missing from Google hits', `The dataLayer sets them, but the latest Google hit carries no state for ${dropped.join(' and ')}.`, 'Check the CMP or consent template is up to date and passes both v2 parameters through to Google tags.');
      }
      // A library request (gtm.js, gtag/js) before the default is normal: a CMP template sets the default inside GTM
      // on Consent Initialization, after the container has loaded. The default is late only if a Google tag has
      // already sent data, or a gtag config/event command was queued ahead of it.
      const defIdx = dl.findIndex(e => e.args && e.args[0] === 'consent' && e.args[1] === 'default');
      const earlyHits = googleReqs.filter(r => r.kind === 'hit' && r.t < def.t - 50);
      const earlyCmds = dl.slice(0, defIdx).filter(e => e.args && (e.args[0] === 'config' || e.args[0] === 'event'));
      const lateDefault = earlyHits.length > 0 || earlyCmds.length > 0;
      if (lateDefault) add('fail', 'Consent default set after Google tags fired',
        earlyHits.length ? `${earlyHits.length} Google hit${earlyHits.length > 1 ? 's were' : ' was'} sent before the consent default.` : `gtag('${earlyCmds[0].args[0]}') was called before the consent default.`,
        'Fire the consent default on the Consent Initialization trigger, or place it above the GTM or gtag snippet, before any config or event command.');
      // Advanced vs Basic can only be judged when the default came first; otherwise hits after it are not cookieless pings.
      if (deniedByDefault && !lateDefault) {
        const pings = reqs.filter(r => r.kind === 'hit' && ((r.vendor === 'ga4' && !analyticsOk(r.t)) || (r.vendor === 'gads' && !adsOk(r.t))) && r.t >= def.t);
        if (pings.length) add('info', 'Advanced Consent Mode', `${pings.length} cookieless ping${pings.length > 1 ? 's' : ''} sent while consent was denied${pings[0].gcs ? ' (' + gcsLabel(pings[0].gcs) + ')' : ''}. This enables conversion modelling.`);
        else add('info', 'Basic Consent Mode', 'Google tags wait until consent is given. Simpler, but no conversion modelling for users who decline.');
      }
      if (!updates.length) add('info', 'No consent choice made yet', 'Accept or reject the banner, then check this audit again to see how tags react.');
    }
  }

  // CMP
  if (cmp.length) add('pass', 'Consent banner platform detected', cmp.join(', '));
  else if (anyMarketing && !def && !sentDefault) add('warn', 'No consent platform detected', 'No known CMP script was seen.', 'If you serve UK or EEA visitors, a CMP that sends Consent Mode signals is needed.');

  // Cookies before consent
  const consentManaged = deniedByDefault || cmp.length > 0;
  if (consentManaged) {
    const early = trackingCookies.filter(c => !c.existing && !cookieOk(c));
    early.forEach(c => { c.early = true; });
    const late = early.filter(c => afterChoice(c.t)).length;
    const old = trackingCookies.filter(c => c.existing);
    if (old.length) add('info', 'Cookies from an earlier visit', `${old.length} tracking cookie${old.length > 1 ? 's were' : ' was'} already set when the page opened, so they can\'t be checked.`, 'For a clean consent test, open the site in an Incognito window.');
    if (early.length) add('fail', `${early.length} tracking cookie${early.length > 1 ? 's' : ''} set ${late ? 'without' : 'before'} consent`, early.map(c => `${c.name} (${c.owner})`).join(', ') + (late ? `. ${late} appeared after the visitor's choice, without consent for ${late > 1 ? 'their' : 'its'} purpose.` : ''), 'These cookies should only appear after the visitor accepts the matching purpose. Gate the tags that set them behind consent.');
    else if (trackingCookies.length > old.length || grantT) add('pass', 'No tracking cookies before consent', grantT ? 'Tracking cookies only appeared after consent was granted.' : 'None seen so far.');
  }

  // Non-Google pixels before consent
  if (consentManaged) {
    const early = reqs.filter(r => NON_GOOGLE_ADS.includes(r.vendor) && r.kind === 'hit' && !adsOk(r.t));
    if (early.length) {
      const names = [...new Set(early.map(r => VENDORS[r.vendor]))];
      const late = early.filter(r => afterChoice(r.t)).length;
      add('fail', `Ad pixels fire ${late ? 'without' : 'before'} consent`, `${names.join(', ')} sent ${early.length} hit${early.length > 1 ? 's' : ''} ${late ? `without advertising consent (${late} after the visitor's choice).` : 'before the visitor consented.'}`, 'Non-Google tags don\'t read Consent Mode. Add GTM consent checks or fire them on consent-based triggers.');
    }
  }

  // Loaded but silent
  for (const t of tagList) {
    if (NON_GOOGLE_ADS.includes(t.vendor) && t.loaded && t.hits === 0 && (now.ad_storage === 'granted' || !consentManaged)) {
      add('warn', `${t.name} loads but never fires`, 'The script loaded, but no events were sent.', 'Check the base code initialises with the right ID.');
    }
  }

  // Google Ads + Enhanced Conversions
  for (const g of gads) {
    const conv = g.events.conversion || 0;
    if (conv) {
      if (g.em) add('pass', `Enhanced Conversions active on ${g.id}`, 'Conversion hits include hashed user-provided data.');
      else add('warn', `Enhanced Conversions not detected on ${g.id}`, `${conv} conversion hit${conv > 1 ? 's' : ''} sent without user-provided data.`, 'Turn on Enhanced Conversions and map email and phone in the conversion tag to improve match rates.');
    } else add('info', `Google Ads ${g.id} present`, `${g.hits} remarketing hit${g.hits !== 1 ? 's' : ''}. No conversion fired on this page.`);
  }

  // Key events
  if (keyEvents.length) add('pass', 'Conversion events seen', keyEvents.join(', '));
  else if (tagList.length) add('info', 'No conversion events on this page yet', 'Submit a test form or place a test order, then check again to audit conversion tracking.');

  if (!tagList.length && !cmp.length) add('info', 'No measurement tags found', 'Nothing recognisable has fired yet. Interact with the page or reload it with the extension enabled.');

  // ---- score ----
  const penalty = { fail: 18, warn: 7, info: 0, pass: 0 };
  let score = 100 - checks.reduce((a, c) => a + penalty[c.sev], 0);
  score = Math.max(0, Math.min(100, score));
  if (!tagList.length) score = null;
  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  checks.sort((a, b) => order[a.sev] - order[b.sev]);

  const timeline = dlEvents.map(e => ({ ...e, kind: 'dl' }))
    .concat(consentCmds.map(c => ({ name: 'consent ' + c.type, t: c.t, source: Object.entries(c.params).filter(([k]) => /storage|ad_/.test(k)).map(([k, v]) => `${k}=${v}`).join(' '), kind: 'consent' })))
    .concat(reqs.filter(r => r.kind === 'hit').map(r => ({ name: (r.events || []).join(', ') || 'hit', t: r.t, source: VENDORS[r.vendor] + (r.id ? ' · ' + r.id : '') + (r.gcs ? ' · ' + r.gcs : ''), kind: 'hit', vendor: r.vendor, beforeConsent: consentManaged && !adsOk(r.t) })))
    .concat((s.navs || []).map(n => { let p = n.url || ''; try { const u = new URL(n.url); p = u.pathname + u.search + u.hash; } catch (e) {} return { name: 'route change', t: n.t, source: p, kind: 'nav' }; }))
    .sort((a, b) => a.t - b.t);

  return { score, checks, tags: tagList, consent: {
      def, updates, cmp, grantT, deniedByDefault, now,
      sent: sentHits.length ? Object.fromEntries(SIGNALS.map(k => [k, sentHits[sentHits.length - 1].g[k]])) : null
    }, cookies, keyEvents, timeline, started: s.started, url: s.url };
}

if (typeof module !== 'undefined') module.exports = { analyze, decodeGcd };
