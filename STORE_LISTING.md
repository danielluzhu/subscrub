# Chrome Web Store listing — copy/paste

Everything the Developer Dashboard asks for, pre-written. Fields marked
**required** block submission.

---

## Store listing tab

**Name** (required, ≤75 chars)

```
Subscrub — filter Reddit comments by flair
```

**Short description** (required, ≤132 chars)

```
Collapse Reddit comments by the commenter's user flair. Block a flair in one click; replies stay readable.
```

**Detailed description** (required)

```
Subscrub filters Reddit comment sections by the commenter's user flair.

Tired of every r/nba thread turning into the same flair war? Block "Lakers" and
every Lakers-flaired comment folds into a small one-line bar. Click the bar if you
actually want to read it.

ONLY THE FLAIRED COMMENT IS TOUCHED
Replies to a filtered comment stay fully visible at their normal indent. A reply is
only collapsed if its own author flair matches one of your filters, so you never
lose a conversation because one person in it has a flair you filtered.

THREE WAYS TO ADD A FLAIR
• Open the popup — it lists every flair on the page with counts. Click "Block here".
• Right-click any comment → "Subscrub: filter this commenter's flair".
• Type it yourself, with contains / exact / regex matching.

PER-SUBREDDIT OR GLOBAL
Block "Lakers" only in r/nba while "crypto" is blocked everywhere. Each filter can
collapse (default) or hide entirely, and can be toggled off without deleting it.

WORKS ON BOTH REDDITS
old.reddit.com and new Reddit, including comments that load as you scroll. Matches
flair text, flair image alt text, and old-reddit flair CSS classes, so emoji-only
flairs are caught too.

PRIVATE BY DESIGN
Your filters are stored in your own Chrome profile and sync across your devices via
Chrome. Subscrub has no server, no analytics, and no account. It never sends your
browsing or your filters anywhere. Filtering is cosmetic and local — nothing is
reported to Reddit and no user is blocked or notified.
```

**Category**: Social & Communication
**Language**: English

---

## Graphics (required)

| Asset | Size | Notes |
| --- | --- | --- |
| Store icon | 128×128 | `icons/icon128.png` — already the right size |
| Screenshot | 1280×800 or 640×400 | **At least one required.** 24-bit PNG (no alpha) or JPEG |
| Small promo tile | 440×280 | Optional; needed only to be eligible for featuring |

Take the screenshots on a **real Reddit comments page**, not a mock — reviewers
compare screenshots against what the extension actually does, and store policy
forbids misleading imagery. Two that tell the story:

1. A comments page with several flaired comments collapsed to stubs, with the reply
   threads underneath still readable.
2. The popup open, showing "Flairs on this page" with counts and the Block buttons.

To get exactly 1280×800: open Chrome DevTools → device toolbar → set a custom
1280×800 viewport → capture screenshot.

---

## Privacy tab (required — this is what stalls most reviews)

**Single purpose**

```
Subscrub has one purpose: to filter Reddit comment threads by the commenter's user
flair, collapsing or hiding comments whose flair the user has chosen to filter.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `storage` | Stores the user's list of flair filters and the on/off switch. This is user configuration only; it never leaves the user's Chrome profile except through Chrome's own sync. |
| `contextMenus` | Adds one right-click item on Reddit pages, "Subscrub: filter this commenter's flair", so a flair can be filtered directly from a comment instead of being typed by hand. |
| Host permission `*://*.reddit.com/*` | The extension reads comment markup on Reddit pages to find each commenter's flair and collapse matching comments. Reddit is the only site it runs on, and it makes no network requests of its own. |

**Remote code**: No. All JavaScript and CSS ship inside the package; nothing is
fetched or evaluated at runtime.

**Data usage** — tick nothing on the collection list, then certify all three:
- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending.

**Privacy policy URL**: not required — Subscrub collects no user data. (If the
dashboard insists because of the host permission, a one-page policy stating "this
extension collects, transmits, and stores no user data; filters are saved locally in
your browser" on any public URL satisfies it.)

---

## Distribution

Pick one on the Package/Distribution step:

- **Public** — listed and searchable by anyone.
- **Unlisted** — installable only by people you send the link to. Best if this is for
  you and some friends: no listing polish needed, same one-click install.
- **Private** — only Google accounts you list as trusted testers.

Visibility can be changed later without resubmitting the code.
