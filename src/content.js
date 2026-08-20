/*
 * Subscrub — content script
 *
 * Finds Reddit comments, reads the commenter's own user flair, and censors
 * (collapses or hides) any comment whose flair matches one of the user's
 * filters. Only the matched comment is censored: every reply below it keeps
 * rendering, whatever flair its author has.
 *
 * Supports:
 *   - old.reddit.com          -> div.thing.comment  /  .tagline .flair
 *   - new reddit (shreddit)   -> <shreddit-comment> /  flair nodes in its meta row
 */
(() => {
  'use strict';
  if (window.__SUBSCRUB_LOADED__) return;
  window.__SUBSCRUB_LOADED__ = true;

  /* How long to wait for a lazily-rendered flair before treating a comment as
     genuinely unflaired. Matters for the allowlist, which has to decide about
     comments that never show a flair at all. */
  const FLAIR_GRACE_MS = 1500;
  const COMMENT_SEL = 'shreddit-comment, div.thing.comment';
  const FLAIR_QUERY = [
    '[class*="flair" i]',
    '[id*="flair" i]',
    '[slot*="flair" i]',
    '[data-testid*="flair" i]',
    '[bundlename*="flair" i]'
  ].join(',');
  /* Slots that hold replies or the comment body — never a source of the
     commenter's own flair. */
  const SKIP_SLOTS = new Set(['comment', 'actionRow', 'children', 'commentAvatar']);

  let state = { enabled: true, rules: [], allowAction: 'collapse', allowKeepUnflaired: false };
  let currentSub = detectSubreddit();
  let lastHref = location.href;
  let filtered = 0;
  let seenComments = 0;
  let lastBadge = -1;
  let scanTimer = null;
  let lastContextComment = null;
  const flairIndex = new Map(); // key -> { label, values, count }
  const regexCache = new Map();

  /* ------------------------------------------------------------------ utils */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const kindOf = (el) => (el.matches('div.thing.comment') ? 'old' : 'shreddit');

  function detectSubreddit() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9_]{2,32})/);
    return m ? m[1] : null;
  }

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function uid() {
    return 'r' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /* ---------------------------------------------------------------- storage */

  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(
          { enabled: true, rules: [], allowAction: 'collapse', allowKeepUnflaired: false },
          (data) => {
            state = {
              enabled: data && data.enabled !== false,
              rules: (data && Array.isArray(data.rules)) ? data.rules : [],
              allowAction: (data && data.allowAction === 'hide') ? 'hide' : 'collapse',
              allowKeepUnflaired: !!(data && data.allowKeepUnflaired)
            };
            resolve();
          });
      } catch (_) { resolve(); }
    });
  }

  function addRule(pattern, scope, action) {
    const clean = norm(pattern);
    if (!clean) return;
    chrome.storage.sync.get({ rules: [] }, (data) => {
      const rules = Array.isArray(data.rules) ? data.rules : [];
      const dupe = rules.some((r) =>
        norm(r.pattern).toLowerCase() === clean.toLowerCase() &&
        (r.subreddit || '*') === scope);
      if (dupe) {
        toast('Already filtering “' + clean + '”' + (scope === '*' ? '' : ' in r/' + scope));
        return;
      }
      rules.push({
        id: uid(),
        kind: 'block',
        pattern: clean,
        match: 'contains',
        subreddit: scope,
        action: action || 'collapse',
        enabled: true,
        created: Date.now()
      });
      chrome.storage.sync.set({ rules }, () => {
        toast('Scrubbing “' + clean + '”' + (scope === '*' ? ' everywhere' : ' in r/' + scope));
      });
    });
  }

  /* ------------------------------------------------------- comment discovery */

  function collect(root) {
    const out = [];
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return out;
    if (root.nodeType === 1 && root.matches && root.matches(COMMENT_SEL)) {
      out.push(root);
    }
    root.querySelectorAll(COMMENT_SEL).forEach((el) => out.push(el));
    return out;
  }

  /* ------------------------------------------------------------ flair reading */

  function textsOf(node) {
    const out = [];
    const push = (v) => {
      const n = norm(v);
      if (n && !out.includes(n)) out.push(n.slice(0, 140));
    };
    push(node.textContent);
    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach((img) => {
        push(img.getAttribute('alt'));
        push(img.getAttribute('title'));
      });
    }
    if (node.getAttribute) {
      push(node.getAttribute('title'));
      push(node.getAttribute('aria-label'));
    }
    return out;
  }

  /* The flair must belong to THIS comment. Without this check a wrapper that
     holds the reply subtree can hand us a reply author's flair, and the parent
     gets censored for a flair it never had. */
  function owns(el, node, kind) {
    return node.closest(kind === 'old' ? 'div.thing.comment' : 'shreddit-comment') === el;
  }

  function authorOf(el, kind) {
    return kind === 'old'
      ? norm((el.querySelector(':scope > .entry .tagline a.author') || {}).textContent)
      : norm(el.getAttribute('author'));
  }

  function oldFlairNodes(el) {
    const entry = el.querySelector(':scope > .entry');
    const tagline = entry && entry.querySelector('.tagline');
    if (!tagline) return [];
    return Array.from(tagline.querySelectorAll('.flair'));
  }

  function shredditFlairNodes(el) {
    const scopes = [];
    const meta = el.querySelector(':scope > [slot="commentMeta"]');
    if (meta) {
      scopes.push(meta);
    } else {
      // Unknown markup: scan the comment's own parts, never a reply container.
      for (const child of el.children) {
        if (child.matches(COMMENT_SEL)) continue;
        if (child.querySelector(COMMENT_SEL)) continue;
        if (child.classList && child.classList.contains('subscrub-stub')) continue;
        const slot = child.getAttribute && child.getAttribute('slot');
        if (slot && SKIP_SLOTS.has(slot)) continue;
        if (child.id && /rtjson/.test(child.id)) continue;
        scopes.push(child);
      }
    }
    const out = [];
    const consider = (node) => {
      if (out.includes(node)) return;
      if (out.some((prev) => prev.contains(node))) return; // avoid double-counting nesting
      out.push(node);
    };
    for (const scope of scopes) {
      if (scope.matches && scope.matches(FLAIR_QUERY)) consider(scope);
      if (scope.querySelectorAll) scope.querySelectorAll(FLAIR_QUERY).forEach(consider);
    }
    return out;
  }

  /** @returns {{label:string, values:string[], author:string}|null} */
  function readFlair(el, kind) {
    const nodes = (kind === 'old' ? oldFlairNodes(el) : shredditFlairNodes(el))
      .filter((node) => owns(el, node, kind));
    if (!nodes.length) return null;

    const texts = [];
    const keys = [];
    for (const node of nodes) {
      for (const t of textsOf(node)) if (!texts.includes(t)) texts.push(t);
      if (node.classList) {
        for (const cls of node.classList) {
          const m = cls.match(/^flair-(.+)$/);
          if (m && m[1] && !keys.includes(m[1])) keys.push(m[1]);
        }
      }
    }
    if (!texts.length && !keys.length) return null;

    const author = authorOf(el, kind);

    return {
      label: texts[0] || ':' + keys[0],
      values: texts.concat(keys).map((v) => v.toLowerCase()),
      author: author || ''
    };
  }

  /* ---------------------------------------------------------------- matching */

  function valuesMatch(rule, values) {
    const pattern = norm(rule.pattern);
    if (!pattern) return false;
    const mode = rule.match || 'contains';
    if (mode === 'regex') {
      let re = regexCache.get(pattern);
      if (re === undefined) {
        try { re = new RegExp(pattern, 'i'); } catch (_) { re = null; }
        regexCache.set(pattern, re);
      }
      return re ? values.some((v) => re.test(v)) : false;
    }
    const needle = pattern.toLowerCase();
    if (mode === 'exact') return values.some((v) => v === needle);
    return values.some((v) => v.includes(needle));
  }

  function scopeMatches(rule) {
    const scope = rule.subreddit || '*';
    if (scope === '*') return true;
    return !!currentSub && scope.toLowerCase() === currentSub.toLowerCase();
  }

  function matchRule(values, kind) {
    const want = kind || 'block';
    if (!values) return null;
    for (const rule of state.rules) {
      if (rule.enabled === false) continue;
      if ((rule.kind || 'block') !== want) continue;
      if (!scopeMatches(rule)) continue;
      if (valuesMatch(rule, values)) return rule;
    }
    return null;
  }

  /* Is an allowlist in force for this page? One enabled allow rule whose scope
     covers where we are is enough. */
  function allowlistActive() {
    return state.rules.some((r) =>
      (r.kind || 'block') === 'allow' && r.enabled !== false && scopeMatches(r));
  }

  /* What should happen to a comment with these flair values (null = no flair)?
     Blocklist wins over allowlist, so a blocked flair stays blocked even if the
     allowlist names it. Returns null to leave the comment alone. */
  function decide(values) {
    const blocked = matchRule(values, 'block');
    if (blocked) {
      return {
        reason: 'block',
        action: blocked.action === 'hide' ? 'hide' : 'collapse',
        rule: blocked
      };
    }
    if (!allowlistActive()) return null;
    if (matchRule(values, 'allow')) return null;
    if (!values && state.allowKeepUnflaired) return null;
    return {
      reason: 'allow',
      action: state.allowAction === 'hide' ? 'hide' : 'collapse',
      rule: null
    };
  }

  /* ---------------------------------------------------------------- censoring
   *
   * A comment element on both Reddits also contains its replies, so censoring
   * is done part by part: each direct child is either one of the comment's own
   * parts (meta row, body, votes, action row -> hidden) or something that holds
   * replies (-> always left alone). Anything we cannot see into is treated as a
   * reply holder, so a thread can never disappear because of a guess.
   */

  function holdsReplies(child, kind) {
    if (child.matches(COMMENT_SEL)) return true;          // a reply itself
    if (child.querySelector(COMMENT_SEL)) return true;    // wrapper around replies
    if (child.shadowRoot) return true;                    // can't see inside — assume replies
    if (kind === 'old') return child.classList.contains('child');
    const slot = child.getAttribute('slot');
    if (slot) return slot === 'children';
    // Unslotted custom element (a lazy "more replies" partial, say): leave it.
    return child.tagName.includes('-');
  }

  function censorParts(el, kind) {
    const censoring = el.dataset.subscrubState === 'collapsed' ||
                      el.dataset.subscrubState === 'hidden';
    for (const child of el.children) {
      if (!child.dataset || child.classList.contains('subscrub-stub')) continue;
      if (!censoring) {
        delete child.dataset.subscrubPart;
        continue;
      }
      // Already established as a reply holder: it stays visible, no re-check.
      if (child.dataset.subscrubPart === 'kept') continue;
      if (holdsReplies(child, kind)) child.dataset.subscrubPart = 'kept';
      else child.dataset.subscrubPart = 'hidden';
    }
  }

  function applyDecision(el, kind, decision, flair) {
    if (el.dataset.subscrubUser === 'expanded') return;
    filtered++;
    el.dataset.subscrubFlair = flair ? flair.label : '(no flair)';
    el.dataset.subscrubReason = decision.reason;
    el.dataset.subscrubRule = decision.rule ? (decision.rule.id || '') : '';
    el.dataset.subscrubState = decision.action === 'hide' ? 'hidden' : 'collapsed';
    if (decision.action !== 'hide' && !el.querySelector(':scope > .subscrub-stub')) {
      el.insertBefore(buildStub(el, kind, flair, decision), el.firstChild);
    }
    censorParts(el, kind);
  }

  function buildStub(el, kind, flair, decision) {
    const byAllowlist = decision.reason === 'allow';
    const shownFlair = flair ? flair.label : 'no flair';
    const author = flair ? flair.author : authorOf(el, kind);
    const hintText = byAllowlist ? 'not on your allowlist — show' : 'scrubbed — show';
    const stub = document.createElement('div');
    stub.className = 'subscrub-stub';
    stub.setAttribute('role', 'button');
    stub.tabIndex = 0;

    const caret = document.createElement('span');
    caret.className = 'subscrub-caret';
    caret.textContent = '+';

    const who = document.createElement('span');
    who.className = 'subscrub-who';
    who.textContent = author ? 'u/' + author : 'comment';

    const chip = document.createElement('span');
    chip.className = 'subscrub-chip' + (flair ? '' : ' subscrub-chip-empty');
    chip.textContent = shownFlair;

    const hint = document.createElement('span');
    hint.className = 'subscrub-hint';
    hint.textContent = hintText;

    stub.append(caret, who, chip, hint);
    stub.title = byAllowlist
      ? 'Hidden by your Subscrub allowlist · flair: ' + shownFlair
      : 'Filtered by Subscrub · flair: ' + shownFlair;

    const toggle = () => {
      const collapsed = el.dataset.subscrubState === 'collapsed';
      el.dataset.subscrubState = collapsed ? 'expanded' : 'collapsed';
      if (collapsed) el.dataset.subscrubUser = 'expanded';
      caret.textContent = collapsed ? '−' : '+';
      hint.textContent = collapsed ? 'hide' : hintText;
      censorParts(el, kindOf(el));
    };
    stub.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); toggle(); });
    stub.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return stub;
  }

  /* -------------------------------------------------------------- scan cycle */

  function indexFlair(flair) {
    const key = (flair.values[0] || flair.label).toLowerCase();
    const entry = flairIndex.get(key);
    if (entry) entry.count++;
    else flairIndex.set(key, { label: flair.label, values: flair.values, count: 1 });
  }

  function processComment(el, kind) {
    if (el.dataset.subscrubDone === '1') return;
    const flair = readFlair(el, kind);

    if (!flair) {
      // Flair may still be rendering. Wait out the grace period before calling
      // this comment unflaired — under an allowlist that verdict censors it.
      if (!el.dataset.subscrubSeen) el.dataset.subscrubSeen = String(Date.now());
      if (Date.now() - Number(el.dataset.subscrubSeen) < FLAIR_GRACE_MS) {
        schedule(FLAIR_GRACE_MS); // come back once it has settled
        return;
      }
      el.dataset.subscrubDone = '1';
      if (!state.enabled) return;
      const verdict = decide(null);
      if (verdict) applyDecision(el, kind, verdict, null);
      return;
    }

    el.dataset.subscrubDone = '1';
    indexFlair(flair);
    if (!state.enabled) return;
    const verdict = decide(flair.values);
    if (verdict) applyDecision(el, kind, verdict, flair);
  }

  function scan() {
    scanTimer = null;
    if (!alive()) return;
    const list = collect(document);
    seenComments = list.length;
    for (const el of list) {
      try { processComment(el, kindOf(el)); } catch (_) { /* keep scanning */ }
    }
    // Re-check censored comments: replies (and the controls that load them) can
    // arrive after we censored, and they must never stay hidden.
    document.querySelectorAll('[data-subscrub-state]').forEach((el) => {
      try { censorParts(el, kindOf(el)); } catch (_) { /* keep going */ }
    });
    reportBadge();
  }

  function schedule(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, typeof delay === 'number' ? delay : 120);
  }

  function resetAll() {
    document.querySelectorAll('.subscrub-stub').forEach((n) => n.remove());
    document.querySelectorAll('[data-subscrub-part]').forEach((el) => {
      delete el.dataset.subscrubPart;
    });
    document.querySelectorAll('[data-subscrub-state]').forEach((el) => {
      delete el.dataset.subscrubState;
      delete el.dataset.subscrubFlair;
      delete el.dataset.subscrubRule;
      delete el.dataset.subscrubReason;
    });
    document.querySelectorAll('[data-subscrub-done], [data-subscrub-seen]').forEach((el) => {
      delete el.dataset.subscrubDone;
      delete el.dataset.subscrubSeen;
    });
    filtered = 0;
    flairIndex.clear();
  }

  function reportBadge() {
    if (filtered === lastBadge || !alive()) return;
    lastBadge = filtered;
    try {
      chrome.runtime.sendMessage({ type: 'subscrub:count', filtered }, () => void chrome.runtime.lastError);
    } catch (_) { /* service worker asleep */ }
  }

  /* ------------------------------------------------------------------- toast */

  let toastEl = null;
  let toastTimer = null;
  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'subscrub-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('subscrub-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('subscrub-toast-show'), 2600);
  }

  /* --------------------------------------------------------------- messaging */

  function pageInfo() {
    const allowActive = allowlistActive();
    const flairs = Array.from(flairIndex.values())
      .map((f) => {
        const blocked = !!matchRule(f.values, 'block');
        const allowed = !!matchRule(f.values, 'allow');
        return {
          label: f.label,
          count: f.count,
          blocked,
          allowed,
          hiddenByAllowlist: allowActive && !blocked && !allowed
        };
      })
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 80);
    return {
      ok: true,
      subreddit: currentSub,
      url: location.href,
      flairs,
      filtered,
      comments: seenComments,
      enabled: state.enabled,
      allowActive
    };
  }

  /* What did Subscrub hide, and what did it spare? Run window.__SUBSCRUB__.debug()
     in the console on a page that looks wrong. */
  function describe(node) {
    const slot = node.getAttribute('slot');
    const cls = (node.getAttribute('class') || '').split(/\s+/)[0];
    return node.tagName.toLowerCase() +
      (slot ? '[slot=' + slot + ']' : '') +
      (cls ? '.' + cls : '');
  }

  function debug() {
    const rows = [];
    document.querySelectorAll('[data-subscrub-state]').forEach((el) => {
      const kind = kindOf(el);
      const children = Array.from(el.children);
      rows.push({
        author: el.getAttribute('author') ||
          norm((el.querySelector(':scope > .entry .tagline a.author') || {}).textContent) || '?',
        flair: el.dataset.subscrubFlair,
        state: el.dataset.subscrubState,
        reason: el.dataset.subscrubReason || 'block',
        kind,
        hidden: children.filter((c) => c.dataset && c.dataset.subscrubPart === 'hidden').map(describe),
        spared: children.filter((c) => !c.dataset || c.dataset.subscrubPart !== 'hidden').map(describe),
        repliesInside: el.querySelectorAll(COMMENT_SEL).length,
        repliesVisible: Array.from(el.querySelectorAll(COMMENT_SEL))
          .filter((r) => r.getClientRects().length > 0).length
      });
    });
    if (rows.length && console.table) console.table(rows.map((r) => ({
      author: r.author, flair: r.flair, state: r.state, reason: r.reason,
      hidden: r.hidden.join(' '), spared: r.spared.join(' '),
      replies: r.repliesVisible + '/' + r.repliesInside
    })));
    return rows;
  }

  function blockFromContext() {
    const el = lastContextComment;
    if (!el || !el.isConnected) { toast('Right-click directly on a comment to filter its flair'); return; }
    const flair = readFlair(el, kindOf(el));
    if (!flair) { toast('That comment has no user flair'); return; }
    addRule(flair.label.replace(/^:/, ''), currentSub || '*');
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'subscrub:pageInfo') { sendResponse(pageInfo()); return; }
      if (msg.type === 'subscrub:rescan') { resetAll(); schedule(0); sendResponse({ ok: true }); return; }
      if (msg.type === 'subscrub:contextBlock') { blockFromContext(); sendResponse({ ok: true }); return; }
    });
  } catch (_) { /* not in an extension context (test fixture) */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (!changes.rules && !changes.enabled &&
          !changes.allowAction && !changes.allowKeepUnflaired) return;
      if (changes.rules) state.rules = Array.isArray(changes.rules.newValue) ? changes.rules.newValue : [];
      if (changes.enabled) state.enabled = changes.enabled.newValue !== false;
      if (changes.allowAction) state.allowAction = changes.allowAction.newValue === 'hide' ? 'hide' : 'collapse';
      if (changes.allowKeepUnflaired) state.allowKeepUnflaired = !!changes.allowKeepUnflaired.newValue;
      regexCache.clear();
      resetAll();
      schedule(0);
    });
  } catch (_) { /* ignore */ }

  /* ---------------------------------------------------------------- watchers */

  document.addEventListener('contextmenu', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    lastContextComment = t ? t.closest(COMMENT_SEL) : null;
  }, true);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) { schedule(); return; }
    }
  });

  // Reddit is a SPA: watch for navigations so subreddit scope stays correct.
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const sub = detectSubreddit();
    if (sub !== currentSub) { currentSub = sub; resetAll(); }
    schedule(250);
  }, 700);

  loadState().then(() => {
    scan();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });

  window.__SUBSCRUB__ = { scan, resetAll, pageInfo, debug, get state() { return state; } };
})();
