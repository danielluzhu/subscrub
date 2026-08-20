#!/usr/bin/env python3
"""Generate test/popup-preview.html: the real popup with a stubbed chrome.* API.

Lets you iterate on the popup's look in a normal browser tab instead of
reloading the extension. Regenerate after editing src/popup.html.

    python3 tools/make_popup_preview.py
    python3 -m http.server 8123     # then open /test/popup-preview.html
"""
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

STUB = """<script>
/* Fake extension APIs so the popup renders with sample data. */
window.chrome = {
  storage: {
    _d: { enabled: true, allowAction: 'collapse', allowKeepUnflaired: true, rules: [
      {id:'a',kind:'block',pattern:'lakers',match:'contains',subreddit:'nba',action:'collapse',enabled:true},
      {id:'b',kind:'block',pattern:'Knicks',match:'contains',subreddit:'nba',action:'collapse',enabled:true},
      {id:'c',kind:'block',pattern:'crypto',match:'contains',subreddit:'*',action:'hide',enabled:false},
      {id:'d',kind:'block',pattern:'^(GSW|Warriors)$',match:'regex',subreddit:'*',action:'collapse',enabled:true},
      {id:'e',kind:'allow',pattern:'Celtics',match:'contains',subreddit:'nba',enabled:true},
      {id:'f',kind:'allow',pattern:'Mod',match:'exact',subreddit:'*',enabled:true}
    ]},
    sync: {
      get(def, cb) { cb(Object.assign({}, def, chrome.storage._d)); },
      set(o, cb) { Object.assign(chrome.storage._d, o); if (cb) cb(); }
    },
    onChanged: { addListener() {} }
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.reddit.com/r/nba/comments/x/game_thread/', lastAccessed: 1 }],
    sendMessage: (id, msg, cb) => cb({
      ok: true, subreddit: 'nba', filtered: 24, comments: 180, enabled: true, allowActive: true,
      flairs: [
        {label:'Lakers',count:14,blocked:true,allowed:false,hiddenByAllowlist:false},
        {label:'Celtics',count:9,blocked:false,allowed:true,hiddenByAllowlist:false},
        {label:'Warriors',count:6,blocked:true,allowed:false,hiddenByAllowlist:false},
        {label:'Knicks',count:4,blocked:true,allowed:false,hiddenByAllowlist:false},
        {label:'Heat',count:3,blocked:false,allowed:false,hiddenByAllowlist:true},
        {label:'[NBA] Adam Silver',count:2,blocked:false,allowed:false,hiddenByAllowlist:true}
      ]
    })
  },
  runtime: { lastError: null }
};
</script>"""


def main():
    with open(os.path.join(ROOT, 'src', 'popup.html')) as fh:
        html = fh.read()

    # Rewrite popup-relative asset paths to server-absolute ones.
    html = html.replace('href="popup.css"', 'href="/src/popup.css"')
    html = html.replace('src="../icons/icon48.png"', 'src="/icons/icon48.png"')
    html = html.replace('src="popup.js"', 'src="/src/popup.js"')
    html = html.replace('</head>', STUB + '\n</head>')

    out = os.path.join(ROOT, 'test', 'popup-preview.html')
    with open(out, 'w') as fh:
        fh.write(html)
    print('wrote', os.path.normpath(out))


if __name__ == '__main__':
    main()
