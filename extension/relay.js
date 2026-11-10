// Passes observations from the page world to the extension.
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || !e.data.__tca) return;
  const { type, data, t } = e.data;
  try { chrome.runtime.sendMessage({ kind: 'page', type, data, t }).catch(() => {}); } catch (err) {}
});
