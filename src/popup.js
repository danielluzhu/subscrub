/* Subscrub — popup / options UI */

const $ = (id) => document.getElementById(id);
const REDDIT = /^https?:\/\/([a-z0-9-]+\.)*reddit\.com\//i;
const DEFAULTS = { enabled: true, rules: [], allowAction: 'collapse', allowKeepUnflaired: false };

let store = { ...DEFAULTS };
let page = null;          // pageInfo from the content script
let targetTabId = null;
let flairMode = 'block';  // what the buttons in "Flairs on this page" do

const kindOf = (rule) => (rule.kind === 'allow' ? 'allow' : 'block');
const squash = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/* Mirror of the content script's matcher, against a flair label. */
function patternHits(pattern, match, label) {
  const p = (pattern || '').trim().toLowerCase();
  const v = (label || '').toLowerCase();
  if (!p) return false;
  if (match === 'regex') {
    try { return new RegExp(pattern, 'i').test(v); } catch (_) { return false; }
  }
  if (match === 'exact') return v === p || (squash(p) && squash(v) === squash(p));
  return v.includes(p) || (squash(p) && squash(v).includes(squash(p)));
}
const rulesOf = (kind) => store.rules.filter((r) => kindOf(r) === kind);

/* ------------------------------------------------------------------ storage */

const readStore = () => new Promise((res) => chrome.storage.sync.get(DEFAULTS, res));

const save = (patch) => new Promise((res) => {
  Object.assign(store, patch);
  chrome.storage.sync.set(patch, () => res());
});

/* ---------------------------------------------------------------- page link */

async function findTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && REDDIT.test(active.url || '')) return active;
  // Opened as a full options page: fall back to the most recently used reddit tab.
  const tabs = await chrome.tabs.query({ url: ['*://*.reddit.com/*'] });
  if (!tabs.length) return null;
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function ask(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

async function refreshPage() {
  const tab = await findTab();
  targetTabId = tab ? tab.id : null;
  page = targetTabId != null ? await ask(targetTabId, { type: 'subscrub:pageInfo' }) : null;
}

/* --------------------------------------------------------------- rendering */

const currentSub = () => (page && page.subreddit ? page.subreddit : null);

function renderContext() {
  const sub = currentSub();
  $('context').textContent = !page
    ? 'open a reddit tab to see its flairs'
    : (sub ? 'r/' + sub : 'reddit — not in a subreddit');

  const scope = $('scope');
  const previous = scope.value;
  scope.innerHTML = '';
  if (sub) scope.append(new Option('only r/' + sub, sub));
  scope.append(new Option('all subreddits', '*'));
  if (previous && [...scope.options].some((o) => o.value === previous)) scope.value = previous;
}

function renderFlairs() {
  const list = $('flairList');
  const empty = $('flairEmpty');
  list.innerHTML = '';
  const flairs = (page && page.flairs) || [];
  $('flairCount').textContent = String(flairs.length);

  if (!flairs.length) {
    empty.hidden = false;
    empty.textContent = page
      ? 'No flaired comments spotted yet. Scroll the comments and reopen Subscrub.'
      : 'No reddit tab open. (Just installed? Reload your reddit tabs.)';
    return;
  }
  empty.hidden = true;

  for (const flair of flairs) {
    const pattern = flair.label.replace(/^:/, '');
    // A blocked flair stays scrubbed whatever the allowlist says, so don't
    // offer an allowlist button that would visibly do nothing.
    const settled = flairMode === 'block' ? flair.blocked : (flair.allowed || flair.blocked);

    const row = document.createElement('div');
    row.className = 'item' + (settled || flair.hiddenByAllowlist ? ' blocked' : '');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = flair.label;
    name.title = flair.label;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = flair.count + '×';

    row.append(name, count);

    if (flair.blocked) {
      const t = tag('filtered');
      if (flairMode === 'allow') t.title = 'Blocked flairs stay scrubbed — remove the block first';
      row.append(t);
    }
    else if (flair.allowed) row.append(tag('allowed', 'scope'));
    else if (flair.hiddenByAllowlist) row.append(tag('not allowed'));

    if (!settled) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = flairMode === 'block'
        ? (currentSub() ? 'Block here' : 'Block')
        : (currentSub() ? 'Only here' : 'Only this');
      btn.title = flairMode === 'block'
        ? 'Scrub comments with this flair'
        : 'Show only this flair, scrub the rest';
      btn.addEventListener('click', () => addRule(pattern, currentSub() || '*', 'contains', 'collapse', flairMode));
      row.append(btn);

      if (currentSub()) {
        const all = document.createElement('button');
        all.className = 'icon';
        all.textContent = '🌐';
        all.title = flairMode === 'block'
          ? 'Block this flair in every subreddit'
          : 'Show only this flair in every subreddit';
        all.addEventListener('click', () => addRule(pattern, '*', 'contains', 'collapse', flairMode));
        row.append(all);
      }
    }
    list.append(row);
  }
}

function tag(text, extra) {
  const el = document.createElement('span');
  el.className = 'badge' + (extra ? ' ' + extra : '');
  el.textContent = text;
  return el;
}

function ruleRow(rule) {
  const row = document.createElement('div');
  row.className = 'item' + (rule.enabled === false ? ' blocked' : '');

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'toggle';
  toggle.checked = rule.enabled !== false;
  toggle.title = 'Enable / disable this filter';
  toggle.addEventListener('change', () => update(rule.id, { enabled: toggle.checked }));

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = rule.pattern;
  name.title = `${rule.match || 'contains'} “${rule.pattern}”`;

  const scope = document.createElement('span');
  scope.className = 'badge scope';
  scope.textContent = (rule.subreddit && rule.subreddit !== '*') ? 'r/' + rule.subreddit : 'all';

  const mode = document.createElement('span');
  mode.className = 'badge';
  mode.textContent = rule.match || 'contains';

  const del = document.createElement('button');
  del.className = 'icon';
  del.textContent = '✕';
  del.title = 'Delete filter';
  del.addEventListener('click', () => remove(rule.id));

  row.append(toggle, name, scope, mode);

  if (kindOf(rule) === 'block') {
    const action = document.createElement('select');
    action.className = 'act';
    action.append(new Option('collapse', 'collapse'), new Option('hide', 'hide'));
    action.value = rule.action === 'hide' ? 'hide' : 'collapse';
    action.title = 'What to do with matching comments';
    action.addEventListener('change', () => update(rule.id, { action: action.value }));
    row.append(action);
  }

  row.append(del);
  return row;
}

function sortRules(list) {
  return list.slice().sort((a, b) => {
    const sa = a.subreddit || '*', sb = b.subreddit || '*';
    if (sa !== sb) return sa === '*' ? 1 : sb === '*' ? -1 : sa.localeCompare(sb);
    return (a.pattern || '').localeCompare(b.pattern || '');
  });
}

function renderRules() {
  const blocks = rulesOf('block');
  const allows = rulesOf('allow');

  const blockList = $('rulesList');
  blockList.innerHTML = '';
  $('rulesCount').textContent = String(blocks.length);
  $('rulesEmpty').hidden = blocks.length > 0;
  sortRules(blocks).forEach((r) => blockList.append(ruleRow(r)));

  const allowList = $('allowList');
  allowList.innerHTML = '';
  $('allowCount').textContent = String(allows.length);
  $('allowEmpty').hidden = allows.length > 0;
  $('allowOpts').hidden = allows.length === 0;
  sortRules(allows).forEach((r) => allowList.append(ruleRow(r)));

  $('keepUnflaired').checked = !!store.allowKeepUnflaired;
  $('allowAction').value = store.allowAction === 'hide' ? 'hide' : 'collapse';

  renderAllowStatus(allows);
}

function renderAllowStatus(allows) {
  const note = $('allowStatus');
  const active = allows.some((r) => r.enabled !== false);
  if (!active) { note.hidden = true; return; }

  const sub = currentSub();
  const here = allows.filter((r) => r.enabled !== false &&
    ((r.subreddit || '*') === '*' || (sub && r.subreddit.toLowerCase() === sub.toLowerCase())));

  note.hidden = false;
  if (!here.length) {
    note.textContent = sub
      ? `Not active on r/${sub} — no allowlist covers this subreddit.`
      : 'Not active here — open a subreddit these filters cover.';
    note.className = 'note';
    return;
  }
  const names = here.map((r) => r.pattern).join(', ');
  note.className = 'note on';
  note.textContent = `Active${sub ? ' on r/' + sub : ''}: showing only ${names}` +
    (store.allowKeepUnflaired ? ' (plus unflaired comments).' : ', including scrubbing unflaired comments.');
}

function renderStats() {
  if (!page) { $('stats').textContent = 'no reddit tab'; return; }
  const n = page.filtered || 0;
  $('stats').textContent = `${n} comment${n === 1 ? '' : 's'} scrubbed · ${page.comments || 0} scanned`;
}

function renderAll() {
  $('master').checked = store.enabled !== false;
  renderContext();
  renderFlairs();
  renderRules();
  renderStats();
}

/* ------------------------------------------------------------------ actions */

async function reloadPageInfo() {
  await refreshPage();
  renderContext();
  renderFlairs();
  renderRules();
  renderStats();
}

async function addRule(pattern, subreddit, match, action, kind) {
  const clean = (pattern || '').trim();
  if (!clean) return;
  const wanted = kind === 'allow' ? 'allow' : 'block';
  const dupe = store.rules.some((r) =>
    (r.pattern || '').trim().toLowerCase() === clean.toLowerCase() &&
    (r.subreddit || '*') === subreddit &&
    (r.match || 'contains') === match &&
    kindOf(r) === wanted);
  if (!dupe) {
    await save({
      rules: store.rules.concat([{
        id: 'r' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4),
        kind: wanted,
        pattern: clean,
        match: match || 'contains',
        subreddit: subreddit || '*',
        action: action || 'collapse',
        enabled: true,
        created: Date.now()
      }])
    });
  }
  renderRules();
  setTimeout(reloadPageInfo, 250);
}

async function update(id, patch) {
  await save({ rules: store.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  renderRules();
  setTimeout(reloadPageInfo, 250);
}

async function remove(id) {
  await save({ rules: store.rules.filter((r) => r.id !== id) });
  renderRules();
  setTimeout(reloadPageInfo, 250);
}

/* -------------------------------------------------------------------- wiring */

$('master').addEventListener('change', async () => {
  await save({ enabled: $('master').checked });
  setTimeout(reloadPageInfo, 250);
});

$('flairMode').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  flairMode = btn.dataset.mode;
  [...$('flairMode').children].forEach((b) => b.classList.toggle('on', b === btn));
  renderFlairs();
});

$('type').addEventListener('change', () => {
  // An allow rule says what to KEEP; what happens to the rest is set on the
  // allowlist card, so the per-rule action select doesn't apply.
  $('action').hidden = $('type').value === 'allow';
});

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('pattern');
  const pattern = input.value.trim();
  const match = $('match').value;
  addRule(pattern, $('scope').value, match, $('action').value, $('type').value);

  // Tell the user right away when a typed filter matches nothing on the page —
  // otherwise a near-miss ("Arsenal FC" vs the flair's real text) fails silently.
  const note = $('addMsg');
  const flairs = (page && page.flairs) || [];
  if (pattern && flairs.length && !flairs.some((f) => patternHits(pattern, match, f.label))) {
    note.hidden = false;
    note.className = 'note';
    note.textContent = `“${pattern}” doesn't match any flair seen on this page — ` +
      'check the list above for the exact text.';
  } else if (pattern) {
    const n = flairs.filter((f) => patternHits(pattern, match, f.label))
      .reduce((sum, f) => sum + f.count, 0);
    note.hidden = false;
    note.className = 'note on';
    note.textContent = n
      ? `Matches ${n} comment${n === 1 ? '' : 's'} on this page.`
      : 'Added.';
  }
  input.value = '';
  input.focus();
});

$('keepUnflaired').addEventListener('change', async () => {
  await save({ allowKeepUnflaired: $('keepUnflaired').checked });
  renderRules();
  setTimeout(reloadPageInfo, 250);
});

$('allowAction').addEventListener('change', async () => {
  await save({ allowAction: $('allowAction').value });
  setTimeout(reloadPageInfo, 250);
});

$('rescan').addEventListener('click', async () => {
  if (targetTabId == null) return;
  $('rescan').textContent = 'scanning…';
  await ask(targetTabId, { type: 'subscrub:rescan' });
  setTimeout(async () => {
    await reloadPageInfo();
    $('rescan').textContent = 'Re-scan';
  }, 400);
});

$('reportBtn').addEventListener('click', async () => {
  if (targetTabId == null) {
    $('backupMsg').textContent = 'No reddit tab to report on.';
    $('backupCard').hidden = false;
    return;
  }
  $('reportBtn').textContent = 'collecting…';
  const data = await ask(targetTabId, { type: 'subscrub:report' });
  $('reportBtn').textContent = 'Report';
  const card = $('backupCard');
  card.hidden = false;
  if (!data) {
    $('backupMsg').textContent = 'The page did not respond — reload the reddit tab and try again.';
    return;
  }
  const text = JSON.stringify(data, null, 2);
  $('backupText').value = text;
  try {
    await navigator.clipboard.writeText(text);
    $('backupMsg').textContent = 'Debug report copied to clipboard — paste it wherever needed.';
  } catch (_) {
    $('backupMsg').textContent = 'Debug report below — select and copy it.';
  }
});

$('backupToggle').addEventListener('click', () => {
  const card = $('backupCard');
  card.hidden = !card.hidden;
  if (!card.hidden) $('backupText').value = snapshot();
});

const snapshot = () => JSON.stringify({
  enabled: store.enabled !== false,
  allowAction: store.allowAction,
  allowKeepUnflaired: !!store.allowKeepUnflaired,
  rules: store.rules
}, null, 2);

$('backupCopy').addEventListener('click', async () => {
  const text = snapshot();
  $('backupText').value = text;
  try {
    await navigator.clipboard.writeText(text);
    $('backupMsg').textContent = 'Copied to clipboard.';
  } catch (_) {
    $('backupMsg').textContent = 'Select the text above and copy it.';
  }
});

$('backupLoad').addEventListener('click', async () => {
  try {
    const data = JSON.parse($('backupText').value);
    const incoming = Array.isArray(data) ? data : data.rules;
    if (!Array.isArray(incoming)) throw new Error('no rules array');
    const cleaned = incoming
      .filter((r) => r && typeof r.pattern === 'string' && r.pattern.trim())
      .map((r) => ({
        id: r.id || 'r' + Math.random().toString(36).slice(2, 9),
        kind: r.kind === 'allow' ? 'allow' : 'block',
        pattern: r.pattern.trim(),
        match: ['contains', 'exact', 'regex'].includes(r.match) ? r.match : 'contains',
        subreddit: r.subreddit || '*',
        action: r.action === 'hide' ? 'hide' : 'collapse',
        enabled: r.enabled !== false,
        created: r.created || Date.now()
      }));
    await save({
      rules: cleaned,
      allowAction: data.allowAction === 'hide' ? 'hide' : 'collapse',
      allowKeepUnflaired: !!data.allowKeepUnflaired
    });
    $('backupMsg').textContent = `Loaded ${cleaned.length} filter${cleaned.length === 1 ? '' : 's'}.`;
    renderRules();
    setTimeout(reloadPageInfo, 250);
  } catch (err) {
    $('backupMsg').textContent = 'Could not read that JSON.';
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key of Object.keys(DEFAULTS)) {
    if (changes[key]) store[key] = changes[key].newValue;
  }
  if (!Array.isArray(store.rules)) store.rules = [];
  renderAll();
});

(async function init() {
  const data = await readStore();
  store = { ...DEFAULTS, ...data };
  if (!Array.isArray(store.rules)) store.rules = [];
  await refreshPage();
  renderAll();
})();
