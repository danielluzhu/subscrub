/*
 * Subscrub end-to-end test: loads the REAL extension into a real Chromium.
 *
 * Everything the unit fixture cannot exercise runs here: manifest injection,
 * the isolated world, real chrome.storage, real CSS injection, the MAIN-world
 * bridge, and the popup driving the content script on a live tab.
 *
 * www.reddit.com is mapped to 127.0.0.1 so the content scripts genuinely
 * inject; the page served is test/ext-fixture.html (no stubs, no direct
 * script loads).
 *
 *   node tools/e2e/run.mjs
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8123;
const URL = `http://www.reddit.com:${PORT}/test/ext-fixture.html`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failed++;
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  let browser;
  try {
    await wait(800);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        `--host-resolver-rules=MAP www.reddit.com 127.0.0.1,MAP old.reddit.com 127.0.0.1`,
      ],
    });

    // ---- fixture page with the real content scripts injected ----
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = (m.location() && m.location().url) || '';
      pageErrors.push(m.text() + (url ? ' @' + url : ''));
    });
    page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
    await page.goto(URL, { waitUntil: 'networkidle2' });

    const bridged = await page
      .waitForFunction(() => window.__SUBSCRUB__ && typeof window.__SUBSCRUB__.report === 'function', { timeout: 8000 })
      .then(() => true).catch(() => false);
    check('bridge exposed in page main world', bridged);
    if (!bridged) throw new Error('content scripts did not inject — nothing else can pass');

    const info0 = await page.evaluate(() => window.__SUBSCRUB__.pageInfo());
    check('content script scanned comments', info0.comments > 20, `comments=${info0.comments}`);
    check('flairs read from page', info0.flairs.length >= 5, `flairs=${info0.flairs.length}`);
    check('subreddit detected', info0.subreddit === 'nba', info0.subreddit);
    check('nothing censored with no rules', info0.filtered === 0, `filtered=${info0.filtered}`);

    // ---- popup on a real extension page drives real storage ----
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 8000 });
    const extId = new globalThis.URL(swTarget.url()).host;
    const popup = await browser.newPage();
    const popupErrors = [];
    popup.on('console', (m) => { if (m.type() === 'error') popupErrors.push(m.text()); });
    popup.on('pageerror', (e) => popupErrors.push('pageerror: ' + e.message));
    await popup.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle2' });
    await wait(700);

    const popupSaw = await popup.evaluate(() => ({
      context: document.getElementById('context').textContent,
      flairRows: document.querySelectorAll('#flairList .item').length,
    }));
    check('popup found the reddit tab', popupSaw.context.includes('r/nba'), popupSaw.context);
    check('popup lists page flairs', popupSaw.flairRows >= 5, `rows=${popupSaw.flairRows}`);

    await popup.evaluate(() => {
      document.getElementById('pattern').value = 'arsenal';
      document.getElementById('scope').value = '*';
      document.getElementById('addForm').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await wait(400);
    const addNote = await popup.evaluate(() => document.getElementById('addMsg').textContent);
    check('popup add-form feedback', /Matches \d+ comment/.test(addNote), addNote);

    // ---- the rule reaches the content script through real storage ----
    await wait(2500);
    const after = await page.evaluate(async () => {
      const rep = await window.__SUBSCRUB__.report();
      const v = (el) => !!(el && el.getClientRects().length);
      const c = (a) => document.querySelector(`shreddit-comment[author="${a}"]`);
      const st = (a) => (c(a) ? c(a).dataset.subscrubState || 'untouched' : 'MISSING');
      const dt = document.getElementById('deepThread').shadowRoot;
      return {
        censored: rep.totals.censored,
        censorFailed: rep.totals.censorFailed,
        crest: st('gunner_1886'),
        crest_body_hidden: !v(c('gunner_1886').querySelector(':scope > [slot="comment"]')),
        typed_underscore: st('typed_target'),
        shadow_parts: st('shadow_gunner'),
        shadow_tree: dt.querySelector('[author="shadow_tree_gunner"]').dataset.subscrubState || 'untouched',
        shadow_tree_body_hidden: !v(dt.querySelector('[author="shadow_tree_gunner"] > [slot="comment"]')),
        reply_untouched: st('reply_gunner'),
        old_reply_untouched: document.querySelector('.thing.id-t1_35').dataset.subscrubState || 'untouched',
        unflaired: st('no_flair_guy'),
        realStruct: st('real_gunner'),
        realStructBodyHidden: !v(document.getElementById('t1_real1-comment-rtjson-content')),
        realStructMetaHidden: !v(c('real_gunner').querySelector('summary [slot="commentMeta"]')),
        realStructReplyVisible: v(document.getElementById('t1_real2-comment-rtjson-content')),
        realStructFoldVisible: v(c('real_gunner').querySelector('.fold-more')),
        stubs: document.querySelectorAll('.subscrub-stub').length + dt.querySelectorAll('.subscrub-stub').length,
      };
    });
    check('comments censored via real storage', after.censored >= 5, `censored=${after.censored}`);
    check('real-shreddit-structure comment collapsed', after.realStruct === 'collapsed', after.realStruct);
    check('real-structure body hidden', after.realStructBodyHidden);
    check('real-structure meta hidden', after.realStructMetaHidden);
    check('real-structure reply visible', after.realStructReplyVisible);
    check('real-structure fold-more spared', after.realStructFoldVisible);
    check('no censor failures', after.censorFailed === 0, `failed=${after.censorFailed}`);
    check('crest flair collapsed', after.crest === 'collapsed');
    check('crest body actually hidden (real CSS)', after.crest_body_hidden);
    check('underscore flair matches typed pattern', after.typed_underscore === 'collapsed');
    check('shadow-parts comment collapsed', after.shadow_parts === 'collapsed');
    check('shadow-tree comment collapsed', after.shadow_tree === 'collapsed');
    check('shadow-tree body hidden (adopted styles)', after.shadow_tree_body_hidden);
    check('shreddit reply untouched', after.reply_untouched === 'untouched');
    check('old-reddit reply untouched', after.old_reply_untouched === 'untouched');
    check('unflaired comment untouched', after.unflaired === 'untouched');
    check('stubs rendered', after.stubs >= 5, `stubs=${after.stubs}`);

    // ---- clearing rules restores everything ----
    await popup.evaluate(() => {
      const del = document.querySelectorAll('#rulesList .item button.icon');
      del.forEach((b) => b.click());
    });
    await wait(2500);
    const cleared = await page.evaluate(() => {
      const dt = document.getElementById('deepThread').shadowRoot;
      return document.querySelectorAll('[data-subscrub-state], .subscrub-stub').length +
             dt.querySelectorAll('[data-subscrub-state], .subscrub-stub').length;
    });
    check('clearing rules restores everything', cleared === 0, `leftover=${cleared}`);

    // ---- scan cost on this DOM ----
    const perf = await page.evaluate(async () => {
      const t0 = performance.now();
      await window.__SUBSCRUB__.rescan();
      await new Promise((r) => setTimeout(r, 300));
      return Math.round(performance.now() - t0) - 300;
    });
    check('rescan completes quickly', perf < 500, `~${perf}ms`);

    const realErrors = pageErrors.filter((e) => !/favicon|net::|streamable|404/.test(e));
    check('no page/content-script errors', realErrors.length === 0, realErrors.join(' | '));
    check('no popup errors', popupErrors.length === 0, popupErrors.join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
  }
  console.log(failed ? `\n${failed} FAILURE(S)` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('E2E crashed:', e.message); process.exit(2); });
