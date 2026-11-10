// Turns raw observations into an audit: detected tags, consent state, checks and a score.
const VENDORS = {
  gtm: 'Google Tag Manager', gtag: 'Google tag', ga4: 'Google Analytics 4', gads: 'Google Ads',
  meta: 'Meta Pixel', linkedin: 'LinkedIn Insight Tag', microsoft: 'Microsoft UET', tiktok: 'TikTok Pixel',
  hotjar: 'Hotjar', hubspot: 'HubSpot', clarity: 'Microsoft Clarity'
};
const NON_GOOGLE_ADS = ['meta', 'linkedin', 'microsoft', 'tiktok'];
const TRACKING_COOKIES = [
  [/^_ga($|_)/, 'Google Analytics'], [/^_gid$/, 'Google Analytics'], [/^_gcl_/, 'Google Ads'],
  [/^_fbp$|^_fbc$/, 'Meta'], [/^_uet(sid|vid)$/, 'Microsoft Ads'], [/^MUID$/, 'Microsoft'],
  [/^li_fat_id$|^lidc$|^bcookie$/, 'LinkedIn'], [/^_ttp$/, 'TikTok'], [/^_hj/, 'Hotjar'],
  [/^__hstc$|^hubspotutk$|^__hssc$/, 'HubSpot'], [/^_clck$|^_clsk$/, 'Microsoft Clarity']
];
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
    .map(e => ({ type: e.args[1], params: e.args[2] || {}, t: e.t }));
  const def = consentCmds.find(c => c.type === 'default');
  const updates = consentCmds.filter(c => c.type === 'update');
  const grant = updates.find(c => c.params.ad_storage === 'granted' || c.params.analytics_storage === 'granted');
  const grantT = grant ? grant.t : null;
  const deniedByDefault = !!def && ['ad_storage', 'analytics_storage'].some(k => def.params[k] === 'denied');
  const cmp = [...new Set(reqs.filter(r => r.vendor === 'cmp').map(r => r.id))];
  const before = t => grantT === null || t < grantT;

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
  const firstGoogleT = googleReqs.length ? Math.min(...googleReqs.map(r => r.t)) : null;
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
    return { name, t, existing: !!(v && v.existing), owner: match ? match[1] : null };
  }).sort((a, b) => a.t - b.t);
  const trackingCookies = cookies.filter(c => c.owner);

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
      if (pv === 1) add('pass', `GA4 ${g.id} is firing`, `${g.hits} hit${g.hits > 1 ? 's' : ''} sent, including one page_view.`);
      else if (pv > 1) add('warn', `GA4 ${g.id} sent page_view ${pv} times`, 'Duplicate page views inflate sessions and distort engagement metrics.', 'Look for the config tag firing twice, or gtag.js and GTM both sending page views. Single-page apps changing route are the exception.');
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
      if (gcsSeen) add('warn', 'Consent signals sent without a visible default', 'Google hits carry consent state, but no consent default command was seen in the dataLayer.', 'Set consent defaults with gtag(\'consent\', \'default\', …) before any Google tag runs.');
      else add('fail', 'Consent Mode not implemented', 'Google tags fire with no consent default.', 'Google requires Consent Mode v2 for UK and EEA traffic to keep ad personalisation and measurement. Set defaults through your CMP or a GTM consent template.');
    } else {
      const states = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'].map(k => `${k}: ${def.params[k] || '—'}`).join(' · ');
      add('pass', 'Consent default is set', states);
      const missing = ['ad_user_data', 'ad_personalization'].filter(k => !(k in def.params));
      if (missing.length) add('warn', 'Consent Mode v2 signals missing', `Default doesn't set ${missing.join(' and ')}.`, 'Add both v2 parameters to the default and update commands, or Google Ads audiences and conversions will be limited.');
      const lateDefault = firstGoogleT !== null && def.t > firstGoogleT + 50;
      if (lateDefault) add('fail', 'Consent default set after Google tags loaded', 'Tags ran before they knew the consent state.', 'Fire the consent default on the Consent Initialization trigger, or place it above the GTM snippet.');
      // Advanced vs Basic can only be judged when the default came first; otherwise hits after it are not cookieless pings.
      if (deniedByDefault && !lateDefault) {
        const pings = reqs.filter(r => r.kind === 'hit' && (r.vendor === 'ga4' || r.vendor === 'gads') && r.t >= def.t && before(r.t));
        if (pings.length) add('info', 'Advanced Consent Mode', `${pings.length} cookieless ping${pings.length > 1 ? 's' : ''} sent before consent${pings[0].gcs ? ' (' + gcsLabel(pings[0].gcs) + ')' : ''}. This enables conversion modelling.`);
        else add('info', 'Basic Consent Mode', 'Google tags wait until consent is given. Simpler, but no conversion modelling for users who decline.');
      }
      if (!updates.length) add('info', 'No consent choice made yet', 'Accept or reject the banner, then check this audit again to see how tags react.');
    }
  }

  // CMP
  if (cmp.length) add('pass', 'Consent banner platform detected', cmp.join(', '));
  else if (anyMarketing && !def) add('warn', 'No consent platform detected', 'No known CMP script was seen.', 'If you serve UK or EEA visitors, a CMP that sends Consent Mode signals is needed.');

  // Cookies before consent
  const consentManaged = deniedByDefault || cmp.length > 0;
  if (consentManaged) {
    const early = trackingCookies.filter(c => !c.existing && before(c.t));
    const old = trackingCookies.filter(c => c.existing);
    if (old.length) add('info', 'Cookies from an earlier visit', `${old.length} tracking cookie${old.length > 1 ? 's were' : ' was'} already set when the page opened, so they can\'t be checked.`, 'For a clean consent test, open the site in an Incognito window.');
    if (early.length) add('fail', `${early.length} tracking cookie${early.length > 1 ? 's' : ''} set before consent`, early.map(c => `${c.name} (${c.owner})`).join(', '), 'These cookies should only appear after the visitor accepts. Gate the tags that set them behind consent.');
    else if (trackingCookies.length > old.length || grantT) add('pass', 'No tracking cookies before consent', grantT ? 'Tracking cookies only appeared after consent was granted.' : 'None seen so far.');
  }

  // Non-Google pixels before consent
  if (consentManaged) {
    const early = reqs.filter(r => NON_GOOGLE_ADS.includes(r.vendor) && r.kind === 'hit' && before(r.t));
    if (early.length) {
      const names = [...new Set(early.map(r => VENDORS[r.vendor]))];
      add('fail', 'Ad pixels fire before consent', `${names.join(', ')} sent ${early.length} hit${early.length > 1 ? 's' : ''} before the visitor consented.`, 'Non-Google tags don\'t read Consent Mode. Add GTM consent checks or fire them on consent-based triggers.');
    }
  }

  // Loaded but silent
  for (const t of tagList) {
    if (NON_GOOGLE_ADS.includes(t.vendor) && t.loaded && t.hits === 0 && (grantT || !consentManaged)) {
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
    .concat(reqs.filter(r => r.kind === 'hit').map(r => ({ name: (r.events || []).join(', ') || 'hit', t: r.t, source: VENDORS[r.vendor] + (r.id ? ' · ' + r.id : '') + (r.gcs ? ' · ' + r.gcs : ''), kind: 'hit', vendor: r.vendor, beforeConsent: consentManaged && before(r.t) })))
    .sort((a, b) => a.t - b.t);

  return { score, checks, tags: tagList, consent: { def, updates, cmp, grantT, deniedByDefault }, cookies, keyEvents, timeline, started: s.started, url: s.url };
}

if (typeof module !== 'undefined') module.exports = { analyze };
