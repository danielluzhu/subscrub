/*
 * Subscrub live test: the REAL extension against the REAL reddit.com.
 *
 * Opens a busy thread on old.reddit.com and on new reddit, blocks the most
 * common flair on the page through the real popup, and verifies comments
 * actually get scrubbed. Prints report() samples (markup skeletons) so
 * selector bugs are diagnosable from the output.
 *
 *   node tools/e2e/live.mjs
 */
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
let failures = 0;

function check(name, ok, detail) {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + detail + ']' : ''}`);
  if (!ok) failures++;
}
function note(name, detail) { out.push(`INFO  ${name}: ${detail}`); }

async function driveThread(browser, extId, url, label) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    check(`${label}: page loaded`, false, e.message);
    await page.close();
    return;
  }
  await wait(4000);

  const bridged = await page
    .waitForFunction(() => window.__SUBSCRUB__ && window.__SUBSCRUB__.pageInfo, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(`${label}: content scripts injected`, bridged);
  if (!bridged) { await page.close(); return; }

  // let lazy comments/flair settle, then look at what we can read
  await wait(4000);
  const info = await page.evaluate(() => window.__SUBSCRUB__.pageInfo());
  check(`${label}: comments found`, info.comments > 5, `comments=${info.comments}`);
  note(`${label}: flairs read`, info.flairs.slice(0, 8).map((f) => `${f.label}×${f.count}`).join(', ') || 'NONE');
  if (!info.flairs.length) {
    // Distinguish "we failed to read flair" from "reddit rendered none".
    // Logged out, new reddit renders no comment author flair at all.
    const flairInDom = await page.evaluate(() => {
      let found = 0;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.closest && el.closest('shreddit-comment, .thing.comment')) {
            const tag = el.tagName.toLowerCase();
            const cls = el.getAttribute('class') || '';
            if (tag.includes('flair') || /flair/i.test(cls)) found++;
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return found;
    });
    if (flairInDom === 0) {
      note(`${label}: no flair markup in DOM`, 'reddit renders no comment flair logged-out — nothing to read, skipping');
      await page.close();
      return;
    }
    const rep = await page.evaluate(() => window.__SUBSCRUB__.report());
    note(`${label}: sample markup`, '\n' + rep.samples.map((s) => s.markup).join('\n---\n'));
    check(`${label}: flairs readable`, false, `flair markup present (${flairInDom} nodes) but none read`);
    await page.close();
    return;
  }

  // block the most common flair via the real popup
  const target = info.flairs[0].label.replace(/^:/, '').replace(/:$/, '');
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'networkidle2' });
  await wait(600);
  await popup.evaluate((pattern) => {
    document.getElementById('pattern').value = pattern;
    document.getElementById('scope').value = '*';
    document.getElementById('addForm').dispatchEvent(new Event('submit', { cancelable: true }));
  }, target);
  await wait(3500);

  const result = await page.evaluate(async () => {
    const rep = await window.__SUBSCRUB__.report();
    const rows = await window.__SUBSCRUB__.debug();
    return {
      totals: rep.totals,
      badReplies: rows.filter((r) => r.repliesHiddenByUs > 0).length,
      sample: rep.samples[0] ? rep.samples[0].markup.split('\n').slice(0, 12).join('\n') : '(none)',
      scans: rep.scans,
    };
  });
  check(`${label}: comments scrubbed for "${target}"`, result.totals.censored > 0,
    `censored=${result.totals.censored} of ${result.totals.comments}`);
  check(`${label}: no censor failures`, result.totals.censorFailed === 0, `failed=${result.totals.censorFailed}`);
  check(`${label}: replies never hidden`, result.badReplies === 0, `bad=${result.badReplies}`);
  note(`${label}: top sample markup`, '\n' + result.sample);

  // scan cost on a real thread
  const scanMs = await page.evaluate(async () => {
    const before = performance.now();
    await window.__SUBSCRUB__.rescan();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const inf = window.__SUBSCRUB__ && await window.__SUBSCRUB__.pageInfo();
      if (inf && inf.msSinceScan !== null && inf.msSinceScan < 400) break;
    }
    return Math.round(performance.now() - before);
  });
  note(`${label}: rescan wall time`, scanMs + 'ms');
  check(`${label}: scan not pathological`, scanMs < 5000, scanMs + 'ms');

  const realErrors = errors.filter((e) => !/ResizeObserver|Script error/.test(e));
  check(`${label}: no content-script page errors`, realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  // clean up rules for the next phase
  await popup.evaluate(() => {
    document.querySelectorAll('#rulesList .item button.icon').forEach((b) => b.click());
  });
  await wait(800);
  await popup.close();
  await page.close();
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--lang=en-US',
    ],
  });
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 8000 });
    const extId = new URL(swTarget.url()).host;

    // find a busy r/soccer thread via the JSON api
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    let permalink = null;
    try {
      await page.goto('https://old.reddit.com/r/soccer/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1500));
      permalink = await page.evaluate(() => {
        // pick the listing's busiest thread by its comment-count link
        const rows = Array.from(document.querySelectorAll('.thing.link'))
          .map((el) => {
            const a = el.querySelector('a.comments');
            const n = a ? parseInt((a.textContent.match(/\d+/) || ['0'])[0], 10) : 0;
            return { n, href: a ? a.getAttribute('href') : null };
          })
          .filter((r) => r.href && r.n > 80)
          .sort((a, b) => b.n - a.n);
        if (!rows.length) return null;
        return new URL(rows[0].href).pathname;
      });
      if (!permalink) {
        note('listing page body head', await page.evaluate(() => document.body.innerText.slice(0, 200)));
      }
    } catch (e) {
      note('thread discovery', 'failed: ' + e.message);
    }
    await page.close();
    check('found a busy live thread', !!permalink, permalink || 'reddit unreachable');
    if (permalink) {
      await driveThread(browser, extId, `https://old.reddit.com${permalink}`, 'old-reddit');
      await driveThread(browser, extId, `https://www.reddit.com${permalink}`, 'new-reddit');
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(out.join('\n'));
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('live e2e crashed:', e.message); process.exit(2); });
