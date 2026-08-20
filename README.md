# Subscrub

A Chrome extension that filters Reddit comments by the **commenter's user flair**.
Block `Lakers` in r/nba and every Lakers-flaired comment collapses to a one-line stub
you can click open if you're curious.

![icon](icons/icon48.png)

## Features

- **Collapse or hide** comments whose author flair matches one of your filters.
  Collapse is the default — the comment folds into a small
  `+ u/name · Lakers · scrubbed — show` bar. Click it to read it anyway.
- **Replies are never touched.** Only the flaired comment itself is censored;
  the thread hanging off it stays fully readable at its normal indent. A reply
  is only collapsed if its *own* author flair matches a filter.
- **Allowlist mode — "show only these flairs."** The inverse of blocking: name the
  flairs you want to see and everything else in that scope gets scrubbed. Add
  `Celtics` in r/nba and only Celtics-flaired comments stay open there. Comments
  with no flair at all are scrubbed too, since they aren't on the list — untick
  that with **Keep comments with no flair** if a sub is mostly unflaired.
  Blocklist beats allowlist: a blocked flair stays scrubbed even if the allowlist
  names it.
- **Three ways to add a flair**, so you never have to type one exactly:
  1. Open the popup — it lists **every flair on the page** with counts. The
     Block / Show-only switch decides which list a click adds to.
  2. **Right-click any comment** → *Subscrub: filter this commenter's flair*.
  3. Type it manually in the popup (`contains` / `is exactly` / `regex`).
- **Per-subreddit or global scope**, for both lists. `lakers` can be blocked only in
  r/nba while `crypto` is blocked everywhere; an allowlist scoped to r/nba leaves
  every other subreddit untouched.
- Works on **old.reddit.com** and **new Reddit** (`shreddit`), including comments
  loaded lazily as you scroll or click *load more*.
- Matches flair **text, image alt text, and old-reddit `flair-*` CSS classes**, so
  emoji-only flairs still get caught.
- Toolbar badge shows how many comments were scrubbed on the current tab.
- Master on/off switch, per-filter enable/disable, and JSON backup/restore.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`subscrub/`).
4. Reload any Reddit tabs you already had open — content scripts only attach on load.

Pin the extension so the popup and its badge are one click away.

## Usage

Open a comments page, then click the Subscrub icon:

- **Flairs on this page** — every flair Subscrub saw, most common first.
  *Block here* creates a filter scoped to the current subreddit; the 🌐 button
  scopes it to all of Reddit. Already-filtered flairs show a `filtered` tag.
- **Add a filter** — pick `block` or `show only`, then free text plus scope, match
  mode, and action:
  - `contains` (default) — `lakers` matches `Lakers`, `Lakers Fan`, `LAKERS #1`.
  - `is exactly` — only the whole flair, case-insensitive.
  - `regex` — e.g. `^(GSW|Warriors)$`. Invalid patterns are ignored, not thrown.
  - Action `collapse` (fold to a stub) or `hide` (remove entirely).
- **Blocked flairs / Show only these flairs** — two lists, each row toggleable,
  switchable, or deletable. The allowlist card also carries its two settings
  (keep-unflaired, and whether non-matching comments collapse or hide) and a
  status line naming exactly what is being shown where. Changes apply to open
  Reddit tabs immediately; nothing needs reloading.
- **Backup** — copy your filters as JSON, or paste JSON back to restore them.

Filters live in `chrome.storage.sync`, so they follow your Chrome profile. Each
rule carries `kind: "block" | "allow"`; rules saved before allowlists existed load
as blocks.

## How it works

`src/content.js` walks the comment tree and reads each commenter's flair:

| Reddit version | Comment node | Flair source |
| --- | --- | --- |
| old.reddit.com | `div.thing.comment` | `.tagline .flair` text + `flair-*` classes |
| new Reddit | `<shreddit-comment>` | flair nodes inside `[slot="commentMeta"]` |

Because a comment element *contains* its replies on both Reddits, censoring is
done part by part rather than by hiding the comment element. Each direct child
is classified in JS: the comment's own parts (meta row, body, votes, action row)
get `data-subscrub-part="hidden"`, and anything that holds replies is left alone
— a reply element, a wrapper containing one, `.child`, `slot="children"`, an
unslotted custom element, or a shadow-root host we cannot see into. Anything
ambiguous counts as a reply holder, so a thread can never disappear because of a
guess, and every scan re-checks censored comments so replies that load later
un-hide their container. (Reddit's own collapse isn't used: it takes the reply
tree with it.)

A comment is judged once: a matching block rule censors it; otherwise, if an
allowlist covers this page and nothing on it matches, it is censored as
not-allowed. Unflaired comments only get that verdict after a 1.5s grace period,
so a slow-rendering flair isn't mistaken for no flair.

Flair reading is ownership-checked — a candidate flair node counts only if
`node.closest(commentSelector)` is the comment being examined. Without that, a
wrapper holding the reply subtree can hand back a *reply author's* flair and get
the parent censored for a flair it never had.

A `MutationObserver` handles infinite scroll and
*load more comments*; a comment whose flair hasn't rendered yet is retried for a
few passes before being written off as flairless. Removing a filter fully undoes
everything — no reload needed.

## Project layout

```
manifest.json          MV3 manifest
src/content.js         comment scanning, flair reading, collapse/hide
src/content.css        stub, badge, and toast styles injected into Reddit
src/background.js      context-menu item + per-tab badge count
src/popup.html/.css/.js  popup UI (also the options page)
icons/                 generated PNGs
tools/make_icons.py    regenerates icons/ (no dependencies)
tools/make_popup_preview.py  builds test/popup-preview.html
test/fixture.html      offline mock of both Reddit DOMs
```

## Development

No build step — edit and hit *Reload* on `chrome://extensions`.

To test the filtering logic without Reddit:

```bash
python3 -m http.server 8123
```

- `http://localhost:8123/test/fixture.html` — mock old-reddit and shreddit comment
  trees with a stubbed `chrome.*` API. Buttons let you add/clear filters live and
  log the page report. Use it to check collapse, hide, nesting, lazy flairs, and
  the full undo path.
- `http://localhost:8123/test/popup-preview.html` — the real popup with sample data
  (run `python3 tools/make_popup_preview.py` after editing the popup).

## Debugging

If a page ever looks wrong, run this in the console on that page:

```js
window.__SUBSCRUB__.debug()
```

It prints one row per censored comment: the flair it read, what it hid, what it
spared, and how many replies inside it are still visible (`visible/total` — those
two numbers should always be equal).

## Publishing

```bash
python3 tools/package.py
```

Builds `dist/subscrub-<version>.zip` with only the files that ship (manifest, `src/`,
`icons/`), after checking the manifest for the things that get an upload rejected —
MV3, a valid version string, a 128px icon, and every referenced file present. Use
`--bump` to patch-bump the version first; the Chrome Web Store rejects a re-upload
that reuses a version number.

[STORE_LISTING.md](STORE_LISTING.md) has the listing copy, permission
justifications, and privacy answers ready to paste into the Developer Dashboard.

## Known limits

- Flair rendered inside a **shadow root** can't be read by a content script, so
  such a comment is left alone rather than guessed at. Reddit currently renders
  comment flair in the light DOM; if that changes, old.reddit.com keeps working.
- On `/r/all`, popular, or a multireddit, the "this subreddit" scope is the literal
  path segment (`all`), so use all-subreddits filters there.
- Filtering is cosmetic and local — it hides comments in your browser, nothing is
  reported to Reddit and no user is blocked.
