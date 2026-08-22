/* One-off: dump full commentMeta HTML from a live new-reddit thread. */
import puppeteer from 'puppeteer';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const url = process.argv[2];

const browser = await puppeteer.launch({ headless: true, args: ['--lang=en-US'] });
try {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 6000));

  const dump = await page.evaluate(() => {
    const hits = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        const attrs = ['class', 'id', 'slot', 'data-testid', 'bundlename', 'name', 'noun']
          .map((a) => el.getAttribute && el.getAttribute(a) || '').join(' ');
        if (tag.includes('flair') || /flair/i.test(attrs)) {
          hits.push({
            tag,
            inComment: !!el.closest('shreddit-comment'),
            html: el.outerHTML.slice(0, 500),
          });
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const raw = document.documentElement.outerHTML;
    return {
      hits: hits.slice(0, 6),
      totalHits: hits.length,
      rawFlairCount: (raw.match(/flair/gi) || []).length,
      rawSnips: [...new Set((raw.match(/.{60}flair.{60}/gi) || []).slice(0, 5))],
    };
  });
  console.log('flair elements found:', dump.totalHits, '· raw "flair" mentions:', dump.rawFlairCount);
  for (const h of dump.hits) console.log('\n---', h.tag, 'inComment:', h.inComment, '\n', h.html);
  for (const r of dump.rawSnips) console.log('\nRAW:', r);
} finally {
  await browser.close();
}
