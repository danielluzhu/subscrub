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
  /* Names reddit uses for the containers that hold (or will hold) replies. */
  const REPLY_HINT = /children|replies|comment-tree|morechildren|more-comments|thread-line/i;

  /* Page stylesheets never apply inside shadow roots, so a censored comment
     living in one needs these rules adopted into its root or nothing visibly
     happens. Mirrors the essential parts of content.css. */
  const SHADOW_CSS = [
    '[data-subscrub-part="hidden"]{display:none!important}',
    '[data-subscrub-state="hidden"]>*:not(.subscrub-stub){display:none!important}',
    'shreddit-comment[data-subscrub-state]{display:block}',
    '.subscrub-stub{display:inline-flex;align-items:center;gap:8px;max-width:100%;',
    'margin:4px 0 6px;padding:5px 10px;border:1px dashed rgba(128,128,128,.45);',
    'border-radius:8px;background:rgba(128,128,128,.08);color:inherit;cursor:pointer;',
    'font:500 12px/1.35 system-ui,sans-serif;opacity:.82;user-select:none}',
    '.subscrub-stub:hover{opacity:1;border-color:rgba(255,69,0,.7)}',
    '.subscrub-caret{width:13px;text-align:center;font-weight:700;color:#ff4500}',
    '.subscrub-who{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:14ch}',
    '.subscrub-chip{padding:1px 7px;border-radius:999px;background:rgba(255,69,0,.16);',
    'color:#d93a00;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22ch}',
    '.subscrub-hint{opacity:.65;font-size:11px;white-space:nowrap}'
  ].join('');

  let shadowSheet = null;
  function ensureShadowStyles(el) {
    const root = el.getRootNode && el.getRootNode();
    if (!root || !root.host) return; // light DOM: content.css already applies
    try {
      if (!shadowSheet) {
        shadowSheet = new CSSStyleSheet();
        shadowSheet.replaceSync(SHADOW_CSS);
      }
      if (!root.adoptedStyleSheets.includes(shadowSheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, shadowSheet];
      }
    } catch (_) {
      if (!root.querySelector('style[data-subscrub]')) {
        const st = document.createElement('style');
        st.setAttribute('data-subscrub', '');
        st.textContent = SHADOW_CSS;
        root.appendChild(st);
      }
    }
  }

  let state = { enabled: true, rules: [], allowAction: 'collapse', allowKeepUnflaired: false };
  let currentSub = detectSubreddit();
  let lastHref = location.href;
  let filtered = 0;
  let seenComments = 0;
  let lastBadge = -1;
  let scanTimer = null;
  let scanDue = 0;
  let scans = 0;
  let lastScanAt = 0;
  let lastContextComment = null;
  const flairIndex = new Map(); // key -> { label, values, count }
  const regexCache = new Map();

  /* ------------------------------------------------------------------ utils */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  /* Lowercase with everything but letters and digits removed: ":Arsenal_Fan:"
     and "arsenal fan" both squash to "arsenalfan". */
  const squash = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
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

  /* Open shadow roots are queryable but document.querySelectorAll never looks
     inside them — and reddit hydrates whole comment batches into shadow-rooted
     containers. Walk every open root so those comments exist for us at all.
     Memoized briefly: several deep queries run per scan. */
  let rootsCache = null;
  let rootsCacheAt = 0;
  function openShadowRoots() {
    if (rootsCache && Date.now() - rootsCacheAt < 100) return rootsCache;
    const roots = [];
    const walk = (r) => {
      r.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
      });
    };
    walk(document);
    rootsCache = roots;
    rootsCacheAt = Date.now();
    return roots;
  }

  function deepQuery(sel) {
    const out = Array.from(document.querySelectorAll(sel));
    for (const root of openShadowRoots()) {
      root.querySelectorAll(sel).forEach((el) => out.push(el));
    }
    return out;
  }

  function collect() {
    return deepQuery(COMMENT_SEL);
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
      // The flair node can BE the image (r/soccer crests, emoji-only flair),
      // not just contain one — read its own alt, not only its descendants'.
      push(node.getAttribute('alt'));
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

  /* Replies are never censored — only top-level comments are. Handles both a
     nested comment tree and a flat one where depth is an attribute. */
  function upOne(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return (root && root.host) ? root.host : null; // step out of a shadow root
  }

  function isTopLevel(el) {
    for (let node = upOne(el); node; node = upOne(node)) {
      if (node.matches && node.matches(COMMENT_SEL)) return false;
    }
    const depth = el.getAttribute && el.getAttribute('depth');
    if (depth !== null && depth !== undefined && depth !== '' && Number(depth) > 0) return false;
    return true;
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

    /* Nothing named "flair"? Subs like r/soccer show the flair as a bare crest
       image in the meta row, so fall back to its alt text (":Arsenal:"). */
    if (!out.length) {
      for (const scope of scopes) {
        if (!scope.querySelectorAll) continue;
        scope.querySelectorAll('img[alt]').forEach((img) => {
          if (!norm(img.getAttribute('alt'))) return;
          if (isAvatarish(img)) return;
          consider(img);
        });
      }
    }
    return out;
  }

  function isAvatarish(img) {
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    if (/avatar|profile|snoo|user icon/.test(alt)) return true;
    return !!img.closest('[slot="commentAvatar"], [class*="avatar" i], a[href*="/user/"]');
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
    if (mode === 'exact') {
      if (values.some((v) => v === needle)) return true;
      const sq = squash(needle);
      return !!sq && values.some((v) => squash(v) === sq);
    }
    if (values.some((v) => v.includes(needle))) return true;
    // Typed patterns rarely match the flair's raw text exactly — reddit renders
    // "Arsenal Fan" as ":arsenal_fan:" or "arsenal-fan". Compare with case,
    // whitespace and punctuation stripped so a hand-typed flair still matches.
    const sq = squash(needle);
    return !!sq && values.some((v) => squash(v).includes(sq));
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

  /* Does this subtree hold a comment? Open shadow roots are queryable, so look
     through them rather than assuming any custom element hides replies. */
  function containsComment(node) {
    if (!node || !node.querySelector) return false;
    if (node.querySelector(COMMENT_SEL)) return true;
    if (node.shadowRoot && node.shadowRoot.querySelector(COMMENT_SEL)) return true;
    for (const inner of node.children) {
      if (inner.shadowRoot && inner.shadowRoot.querySelector(COMMENT_SEL)) return true;
    }
    return false;
  }

  /* Named like something reddit fills with replies later (a lazy partial that
     is empty right now, so containsComment can't see them yet). */
  function looksLikeReplyContainer(child, kind) {
    if (kind === 'old') return child.classList.contains('child');
    if (child.getAttribute('slot') === 'children') return true;
    const tag = child.tagName.toLowerCase();
    if (tag === 'faceplate-partial') return true;
    const id = child.getAttribute('id') || '';
    const cls = child.getAttribute('class') || '';
    return REPLY_HINT.test(tag) || REPLY_HINT.test(id) || REPLY_HINT.test(cls);
  }

  function holdsReplies(child, kind) {
    if (child.matches(COMMENT_SEL)) return true;   // a reply itself
    if (containsComment(child)) return true;       // wrapper around replies
    return looksLikeReplyContainer(child, kind);
  }

  function censorParts(el, kind) {
    const censoring = el.dataset.subscrubState === 'collapsed' ||
                      el.dataset.subscrubState === 'hidden';
    let hidden = 0;
    const parts = [];

    for (const child of el.children) {
      if (!child.dataset || child.classList.contains('subscrub-stub')) continue;
      parts.push(child);
      if (!censoring) {
        delete child.dataset.subscrubPart;
        continue;
      }
      // Already established as a reply holder: it stays visible, no re-check.
      if (child.dataset.subscrubPart === 'kept') continue;
      if (holdsReplies(child, kind)) {
        child.dataset.subscrubPart = 'kept';
      } else {
        child.dataset.subscrubPart = 'hidden';
        hidden++;
      }
    }

    if (!censoring) {
      delete el.dataset.subscrubCensor;
      return;
    }

    // Nothing hidden means we failed to recognise any of the comment's own
    // parts, and the reader sees a stub above a fully visible comment.
    if (hidden === 0 && parts.length) {
      if (!containsComment(el)) {
        // No replies inside, so everything here is this comment's own content.
        parts.forEach((child) => { child.dataset.subscrubPart = 'hidden'; });
        el.dataset.subscrubCensor = 'fallback';
        return;
      }
      el.dataset.subscrubCensor = 'failed';   // surfaced by report()/debug()
      return;
    }
    el.dataset.subscrubCensor = 'parts';
  }

  function applyDecision(el, kind, decision, flair) {
    if (el.dataset.subscrubUser === 'expanded') return;
    ensureShadowStyles(el);
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

  /* Reddit reuses comment elements as you scroll a long thread, so "already
     processed" has to mean "processed for THIS comment", not just this node. */
  function commentId(el) {
    return el.getAttribute('thingid') || el.getAttribute('data-fullname') ||
           el.getAttribute('id') || '';
  }

  function processComment(el, kind) {
    const id = commentId(el);
    if (el.dataset.subscrubDone === '1') {
      if (el.dataset.subscrubId === id) return;
      // Same node, different comment: throw away every verdict we made for it.
      uncensor(el);
      delete el.dataset.subscrubDone;
      delete el.dataset.subscrubNoflair;
      delete el.dataset.subscrubSeen;
      delete el.dataset.subscrubUser;
    }
    el.dataset.subscrubId = id;
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
      el.dataset.subscrubNoflair = '1'; // keep looking: flair can render late
      if (!state.enabled || !isTopLevel(el)) return;
      const verdict = decide(null);
      if (verdict) applyDecision(el, kind, verdict, null);
      return;
    }

    el.dataset.subscrubDone = '1';
    indexFlair(flair);
    if (!state.enabled) return;
    if (!isTopLevel(el)) return;   // replies are left alone whatever their flair
    const verdict = decide(flair.values);
    if (verdict) applyDecision(el, kind, verdict, flair);
  }

  /* Undo a censoring decision (used when a late flair changes the verdict). */
  function uncensor(el) {
    if (!el.dataset.subscrubState) return;
    const stub = el.querySelector(':scope > .subscrub-stub');
    if (stub) stub.remove();
    for (const child of el.children) {
      if (child.dataset) delete child.dataset.subscrubPart;
    }
    delete el.dataset.subscrubState;
    delete el.dataset.subscrubReason;
    delete el.dataset.subscrubFlair;
    delete el.dataset.subscrubRule;
    delete el.dataset.subscrubCensor;
    if (filtered > 0) filtered--;
  }

  /* A comment we read as unflaired may just have been slow. Reddit lazy-loads
     flair, so keep re-reading these for a while instead of writing them off. */
  function recheckUnflaired(el) {
    // No time cap: reddit renders flair whenever a comment scrolls into view,
    // which can be minutes after we first saw it. Re-reading is cheap and the
    // set of unflaired comments is bounded by the page.
    const kind = kindOf(el);
    const flair = readFlair(el, kind);
    if (!flair) return;
    delete el.dataset.subscrubNoflair;
    indexFlair(flair);
    uncensor(el);
    if (!state.enabled || !isTopLevel(el)) return;
    const verdict = decide(flair.values);
    if (verdict) applyDecision(el, kind, verdict, flair);
  }

  function scan() {
    scanTimer = null;
    scanDue = 0;
    if (!alive()) return;
    const list = collect();
    seenComments = list.length;
    for (const el of list) {
      try { processComment(el, kindOf(el)); } catch (_) { /* keep scanning */ }
    }
    deepQuery('[data-subscrub-noflair]').forEach((el) => {
      try { recheckUnflaired(el); } catch (_) { /* keep going */ }
    });
    // Re-check censored comments: replies (and the controls that load them) can
    // arrive after we censored, and they must never stay hidden.
    deepQuery('[data-subscrub-state]').forEach((el) => {
      try {
        if (!isTopLevel(el)) uncensor(el);   // reparented under another comment
        else censorParts(el, kindOf(el));
      } catch (_) { /* keep going */ }
    });
    scans++;
    lastScanAt = Date.now();
    reportBadge();
  }

  /* Earliest request wins. A pending scan must never swallow a sooner one: the
     flair grace period arms a 1.5s timer on any page that has unflaired
     comments, and newly loaded comments can't wait behind it. */
  function schedule(delay) {
    const wait = typeof delay === 'number' ? delay : 120;
    const due = Date.now() + wait;
    if (scanTimer) {
      if (due >= scanDue) return;   // a scan is already coming sooner
      clearTimeout(scanTimer);
    }
    scanDue = due;
    scanTimer = setTimeout(scan, wait);
  }

  function resetAll() {
    deepQuery('.subscrub-stub').forEach((n) => n.remove());
    deepQuery('[data-subscrub-censor]').forEach((el) => {
      delete el.dataset.subscrubCensor;
    });
    deepQuery('[data-subscrub-part]').forEach((el) => {
      delete el.dataset.subscrubPart;
    });
    deepQuery('[data-subscrub-state]').forEach((el) => {
      delete el.dataset.subscrubState;
      delete el.dataset.subscrubFlair;
      delete el.dataset.subscrubRule;
      delete el.dataset.subscrubReason;
      delete el.dataset.subscrubCensor;
    });
    deepQuery('[data-subscrub-done], [data-subscrub-seen]').forEach((el) => {
      delete el.dataset.subscrubDone;
      delete el.dataset.subscrubSeen;
      delete el.dataset.subscrubNoflair;
      delete el.dataset.subscrubId;
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
      scans,
      msSinceScan: lastScanAt ? Date.now() - lastScanAt : null,
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
    console.log('[subscrub] %d scans, last %ss ago · %d comments seen · %d scrubbed · enabled=%s · %d rule(s)',
      scans, ((Date.now() - lastScanAt) / 1000).toFixed(1), seenComments, filtered,
      state.enabled, state.rules.length);
    const rows = [];
    deepQuery('[data-subscrub-state]').forEach((el) => {
      const kind = kindOf(el);
      const children = Array.from(el.children);
      rows.push({
        author: el.getAttribute('author') ||
          norm((el.querySelector(':scope > .entry .tagline a.author') || {}).textContent) || '?',
        flair: el.dataset.subscrubFlair,
        state: el.dataset.subscrubState,
        reason: el.dataset.subscrubReason || 'block',
        topLevel: isTopLevel(el),
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

  /* Diagnostic: find comments whose header mentions a term and report what
     Subscrub actually read from them. window.__SUBSCRUB__.probe('arsenal') */
  function probe(term, limit) {
    const needle = String(term || '').toLowerCase();
    const max = limit || 12;
    const rows = [];
    let matched = 0;

    for (const el of collect()) {
      const kind = kindOf(el);
      const header = kind === 'old'
        ? el.querySelector(':scope > .entry .tagline')
        : el.querySelector(':scope > [slot="commentMeta"]');
      const scope = header || el;
      // innerHTML covers visible text, img alt text and class names at once.
      const hay = (header ? header.innerHTML : ownHtml(el)).toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      matched++;
      if (rows.length >= max) continue;

      const flair = readFlair(el, kind);
      const verdict = flair ? decide(flair.values) : decide(null);
      rows.push({
        author: authorOf(el, kind) || '?',
        topLevel: isTopLevel(el),
        flairRead: flair ? flair.label : '(none found)',
        values: flair ? flair.values.join(' | ') : '',
        wouldCensor: !isTopLevel(el) ? 'no — reply' : (verdict ? verdict.reason : 'no — kept'),
        state: el.dataset.subscrubState || '-',
        usedMetaSlot: !!header,
        html: scope.outerHTML.replace(/\s+/g, ' ').slice(0, 500)
      });
    }

    console.log('[subscrub] %d comment(s) mention %o; showing %d', matched, term, rows.length);
    if (rows.length && console.table) {
      console.table(rows.map((r) => ({
        author: r.author, topLevel: r.topLevel, flairRead: r.flairRead,
        values: r.values, wouldCensor: r.wouldCensor, state: r.state
      })));
      console.log('markup of the first match:\n' + rows[0].html);
    }
    return rows;
  }

  function ownHtml(el) {
    let html = '';
    for (const child of el.children) {
      if (child.matches(COMMENT_SEL) || child.querySelector(COMMENT_SEL)) continue;
      html += child.outerHTML || '';
    }
    return html;
  }

  /* ---------------------------------------------------------------- report
   *
   * window.__SUBSCRUB__.report() — a paste-ready snapshot of what Subscrub did
   * on this page and the markup it had to work with. Comment body text is left
   * out; tag names, attributes and flair text are what matter for diagnosis.
   */
  function skeleton(node, depth, maxDepth) {
    const pad = '  '.repeat(depth);
    const tag = node.tagName.toLowerCase();
    const attrs = ['slot', 'id', 'class', 'alt', 'title', 'depth', 'thingid', 'author',
                   'data-subscrub-part', 'bundlename']
      .map((a) => {
        const v = node.getAttribute && node.getAttribute(a);
        return v ? ' ' + a + '="' + norm(v).slice(0, 70) + '"' : '';
      }).join('');
    const shadow = node.shadowRoot ? ' [shadow-root]' : '';
    const line = pad + '<' + tag + attrs + '>' + shadow;

    const isBody = node.matches && node.matches('[slot="comment"], .usertext, [id*="rtjson"]');
    if (isBody) return line + ' (body text omitted)';

    const kids = Array.from(node.children || []).slice(0, 10);
    if (!kids.length || depth >= maxDepth) {
      const t = norm(node.textContent).slice(0, 50);
      return line + (t ? ' "' + t + '"' : '');
    }
    return line + '\n' + kids.map((k) => skeleton(k, depth + 1, maxDepth)).join('\n');
  }

  function partNames(el, want) {
    return Array.from(el.children)
      .filter((c) => c.dataset && (c.dataset.subscrubPart || '') === want)
      .map((c) => {
        const slot = c.getAttribute('slot');
        const cls = (c.getAttribute('class') || '').split(/\s+/)[0];
        return c.tagName.toLowerCase() + (slot ? '[slot=' + slot + ']' : '') + (cls ? '.' + cls : '');
      });
  }

  function report() {
    const all = collect();
    const tops = all.filter((el) => isTopLevel(el));
    const scored = [];

    for (const el of all) {
      const kind = kindOf(el);
      const flair = readFlair(el, kind);
      const top = isTopLevel(el);
      const verdict = top ? decide(flair ? flair.values : null) : null;
      const censored = !!el.dataset.subscrubState;
      // Rank by how much this comment would tell us about a failure.
      let score = 0;
      if (el.dataset.subscrubCensor === 'failed') score = 100;
      else if (verdict && !censored) score = 90;          // should be scrubbed, isn't
      else if (top && !flair) score = 60;                 // flair not readable
      else if (censored) score = 40;                      // working example
      if (score) scored.push({ el, kind, flair, top, verdict, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const samples = scored.slice(0, 4).map((s) => ({
      author: authorOf(s.el, s.kind) || '?',
      topLevel: s.top,
      flairRead: s.flair ? s.flair.label : '(none found)',
      flairValues: s.flair ? s.flair.values : [],
      wouldCensor: s.verdict ? s.verdict.reason : 'no',
      state: s.el.dataset.subscrubState || '-',
      censorMode: s.el.dataset.subscrubCensor || '-',
      hiddenParts: partNames(s.el, 'hidden'),
      keptParts: partNames(s.el, 'kept'),
      markup: skeleton(s.el, 0, 3)
    }));

    const out = {
      subscrub: (chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version : 'unknown',
      url: location.href.split('?')[0],
      subreddit: currentSub,
      enabled: state.enabled,
      scans,
      msSinceScan: lastScanAt ? Date.now() - lastScanAt : null,
      rules: state.rules.map((r) => ({
        kind: r.kind || 'block', pattern: r.pattern, match: r.match || 'contains',
        subreddit: r.subreddit || '*', action: r.action || 'collapse', enabled: r.enabled !== false
      })),
      totals: {
        comments: all.length,
        topLevel: tops.length,
        flairRead: all.filter((el) => !!readFlair(el, kindOf(el))).length,
        censored: deepQuery('[data-subscrub-state]').length,
        censorFailed: deepQuery('[data-subscrub-censor="failed"]').length,
        censorFallback: deepQuery('[data-subscrub-censor="fallback"]').length
      },
      flairsSeen: Array.from(flairIndex.values())
        .sort((a, b) => b.count - a.count).slice(0, 15)
        .map((f) => f.label + ' ×' + f.count),
      samples
    };

    const text = JSON.stringify(out, null, 2);
    console.log('%c[subscrub] copy everything below this line', 'font-weight:bold');
    console.log(text);
    try { navigator.clipboard.writeText(text).then(
      () => console.log('[subscrub] (also copied to clipboard)'), () => {}); } catch (_) {}
    return out;
  }

  function blockFromContext() {
    const el = lastContextComment;
    if (!el || !el.isConnected) { toast('Right-click directly on a comment to filter its flair'); return; }
    const flair = readFlair(el, kindOf(el));
    if (!flair) { toast('That comment has no user flair'); return; }
    addRule(flair.label.replace(/^:/, ''), currentSub || '*');
  }

  // Answer the main-world bridge (src/bridge.js): the console-facing
  // __SUBSCRUB__ lives in the page world and reaches us through postMessage.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__subscrub) return;
    const { id, cmd, arg } = e.data.__subscrub;
    const fns = { report, debug, probe, pageInfo, rescan };
    let ok = true, data, error = '';
    try {
      if (fns[cmd]) data = fns[cmd](arg);
      else { ok = false; error = 'unknown command: ' + cmd; }
    } catch (err) { ok = false; error = String(err); }
    try {
      window.postMessage({ __subscrubResult: { id, ok, data, error } }, '*');
    } catch (_) {
      window.postMessage({ __subscrubResult: { id, ok: false, data: null,
        error: 'result not serializable' } }, '*');
    }
  });

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'subscrub:pageInfo') { sendResponse(pageInfo()); return; }
      if (msg.type === 'subscrub:report') { sendResponse(report()); return; }
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

  /* Reddit is a SPA: watch for navigations so subreddit scope stays correct.
     The same tick is a backstop for comments that appear without a mutation we
     acted on — "load more comments", infinite scroll, a recycled viewport. */
  let sweepTick = 0;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      const sub = detectSubreddit();
      if (sub !== currentSub) { currentSub = sub; resetAll(); }
      schedule(250);
      return;
    }
    // While any comment still shows no flair, keep scanning: reddit fills flair
    // in with attribute writes and shadow renders that fire no mutation we
    // watch. Throttled — most pages always have some unflaired comments, and
    // this must not become a permanent 700ms full-page rescan.
    if (Date.now() - lastScanAt > 2500 &&
        (document.querySelector('[data-subscrub-noflair]') ||
         openShadowRoots().some((r) => r.querySelector('[data-subscrub-noflair]')))) {
      schedule(0);
      return;
    }
    // Cheap shallow count most ticks; a deep count (through shadow roots) every
    // fourth, since shadow-hydrated batches don't change the shallow count.
    sweepTick++;
    const count = (sweepTick % 4 === 0)
      ? collect().length
      : document.querySelectorAll(COMMENT_SEL).length;
    if (count !== seenComments && (sweepTick % 4 === 0 || count > seenComments)) schedule(0);
  }, 700);

  loadState().then(() => {
    scan();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });

  function rescan() {
    resetAll();
    schedule(0);
    return 'rescanning';
  }

  window.__SUBSCRUB__ = {
    scan, rescan, resetAll, pageInfo, debug, probe, report,
    get state() { return state; }
  };
})();
