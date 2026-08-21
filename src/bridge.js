/*
 * Subscrub — main-world bridge
 *
 * The content script runs in Chrome's isolated world, so its window.__SUBSCRUB__
 * is invisible from the page console unless the user switches the DevTools
 * context dropdown. This file runs in the MAIN world (see manifest) and exposes
 * the same API there, forwarding calls to the content script via postMessage.
 */
(() => {
  'use strict';
  if (window.__SUBSCRUB__) return;

  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__subscrubResult) return;
    const { id, ok, data, error } = e.data.__subscrubResult;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(data);
    else p.reject(new Error(error || 'subscrub error'));
  });

  const call = (cmd, arg) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    window.postMessage({ __subscrub: { id, cmd, arg } }, '*');
    setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error('Subscrub did not respond — reload this tab (content scripts attach on page load).'));
      }
    }, 3000);
  });

  const api = {};
  for (const cmd of ['report', 'debug', 'probe', 'pageInfo', 'rescan']) {
    api[cmd] = (arg) => call(cmd, arg).then((data) => {
      if (data !== undefined) console.log('[subscrub]', data);
      return data;
    });
  }
  window.__SUBSCRUB__ = api;
})();
