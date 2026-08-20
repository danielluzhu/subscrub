/* Subscrub — popup / options UI */

const $ = (id) => document.getElementById(id);
const REDDIT = /^https?:\/\/([a-z0-9-]+\.)*reddit\.com\//i;

let rules = [];
let enabled = true;
let page = null;      // pageInfo from the content script
let targetTabId = null;

/* ------------------------------------------------------------------ storage */

const getStore = () => new Promise((res) =>
  chrome.storage.sync.get({ enabled: true, rules: [] }, res));

const setRules = (next) => new Promise((res) => {
  rules = next;
  chrome.storage.sync.set({ rules: next }, () => res());
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

function currentSub() {
  return page && page.subreddit ? page.subreddit : null;
}

function renderContext() {
  const sub = currentSub();
  if (!page) {
    $('context').textContent = 'open a reddit tab to see its flairs';
  } else if (sub) {
    $('context').textContent = 'r/' + sub;
  } else {
    $('context').textContent = 'reddit — not in a subreddit';
  }

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
    const row = document.createElement('div');
    row.className = 'item' + (flair.blocked ? ' blocked' : '');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = flair.label;
    name.title = flair.label;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = flair.count + '×';

    row.append(name, count);

    if (flair.blocked) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'filtered';
      row.append(badge);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = currentSub() ? 'Block here' : 'Block';
      btn.addEventListener('click', () => addRule(pattern, currentSub() || '*', 'contains', 'collapse'));
      row.append(btn);

      if (currentSub()) {
        const all = document.createElement('button');
        all.className = 'icon';
        all.textContent = '🌐';
        all.title = 'Block this flair in every subreddit';
        all.addEventListener('click', () => addRule(pattern, '*', 'contains', 'collapse'));
        row.append(all);
      }
    }
    list.append(row);
  }
}

function renderRules() {
  const list = $('rulesList');
  list.innerHTML = '';
  $('rulesCount').textContent = String(rules.length);
  $('rulesEmpty').hidden = rules.length > 0;

  const sorted = rules.slice().sort((a, b) => {
    const sa = a.subreddit || '*', sb = b.subreddit || '*';
    if (sa !== sb) return sa === '*' ? 1 : sb === '*' ? -1 : sa.localeCompare(sb);
    return (a.pattern || '').localeCompare(b.pattern || '');
  });

  for (const rule of sorted) {
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

    const action = document.createElement('select');
    action.className = 'act';
    action.append(new Option('collapse', 'collapse'), new Option('hide', 'hide'));
    action.value = rule.action === 'hide' ? 'hide' : 'collapse';
    action.title = 'What to do with matching comments';
    action.addEventListener('change', () => update(rule.id, { action: action.value }));

    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = 'Delete filter';
    del.addEventListener('click', () => remove(rule.id));

    row.append(toggle, name, scope, mode, action, del);
    list.append(row);
  }
}

function renderStats() {
  if (!page) { $('stats').textContent = 'no reddit tab'; return; }
  const n = page.filtered || 0;
  $('stats').textContent = `${n} comment${n === 1 ? '' : 's'} scrubbed · ${page.comments || 0} scanned`;
}

function renderAll() {
  $('master').checked = enabled;
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
  renderStats();
}

async function addRule(pattern, subreddit, match, action) {
  const clean = (pattern || '').trim();
  if (!clean) return;
  const dupe = rules.some((r) =>
    (r.pattern || '').trim().toLowerCase() === clean.toLowerCase() &&
    (r.subreddit || '*') === subreddit &&
    (r.match || 'contains') === match);
  if (!dupe) {
    await setRules(rules.concat([{
      id: 'r' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4),
      pattern: clean,
      match: match || 'contains',
      subreddit: subreddit || '*',
      action: action || 'collapse',
      enabled: true,
      created: Date.now()
    }]));
  }
  renderRules();
  setTimeout(reloadPageInfo, 250);
}

async function update(id, patch) {
  await setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  renderRules();
  setTimeout(reloadPageInfo, 250);
}

async function remove(id) {
  await setRules(rules.filter((r) => r.id !== id));
  renderRules();
  setTimeout(reloadPageInfo, 250);
}

/* -------------------------------------------------------------------- wiring */

$('master').addEventListener('change', () => {
  enabled = $('master').checked;
  chrome.storage.sync.set({ enabled }, () => setTimeout(reloadPageInfo, 250));
});

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('pattern');
  addRule(input.value, $('scope').value, $('match').value, $('action').value);
  input.value = '';
  input.focus();
});

$('backupToggle').addEventListener('click', () => {
  const card = $('backupCard');
  card.hidden = !card.hidden;
  if (!card.hidden) $('backupText').value = JSON.stringify({ enabled, rules }, null, 2);
});

$('backupCopy').addEventListener('click', async () => {
  const text = JSON.stringify({ enabled, rules }, null, 2);
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
        pattern: r.pattern.trim(),
        match: ['contains', 'exact', 'regex'].includes(r.match) ? r.match : 'contains',
        subreddit: r.subreddit || '*',
        action: r.action === 'hide' ? 'hide' : 'collapse',
        enabled: r.enabled !== false,
        created: r.created || Date.now()
      }));
    await setRules(cleaned);
    $('backupMsg').textContent = `Loaded ${cleaned.length} filter${cleaned.length === 1 ? '' : 's'}.`;
    renderRules();
    setTimeout(reloadPageInfo, 250);
  } catch (err) {
    $('backupMsg').textContent = 'Could not read that JSON.';
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.rules) rules = Array.isArray(changes.rules.newValue) ? changes.rules.newValue : [];
  if (changes.enabled) enabled = changes.enabled.newValue !== false;
  renderAll();
});

(async function init() {
  const store = await getStore();
  enabled = store.enabled !== false;
  rules = Array.isArray(store.rules) ? store.rules : [];
  await refreshPage();
  renderAll();
})();
