import { chromium } from 'playwright-core';
import fs from 'fs';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

const OUTBOUND = `48h clock hit INUX (Alien Shiba Inux) — force-exited flat, recycled ~$2.06 into trench (trench life). Equity ~$99.89, cash ~$39.12, 25 bags still cooking. perkspad next ~16:19, then trumpbob/MAMA/Sun. GPU pimp portfolio manager omg lmao`;

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => (p.url()||'').includes('x.com')) || context.pages()[0] || await context.newPage();

  // Confirm account
  const switcher = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
  const sw = await switcher.innerText().catch(()=>'');
  console.log('account:', sw.replace(/\s+/g,' ').trim());
  if (!/DegenDave445/i.test(sw)) {
    console.log('ABORT wrong account');
    await browser.close().catch(()=>{});
    process.exit(2);
  }

  // Scan recent posts for outbound text
  await page.goto('https://x.com/DegenDave445', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  const arts = page.locator('article[data-testid="tweet"]');
  const n = Math.min(await arts.count(), 8);
  const posts = [];
  for (let i=0;i<n;i++) {
    const art = arts.nth(i);
    const text = (await art.locator('[data-testid="tweetText"]').innerText().catch(()=>''));
    const href = await art.locator('a[href*="/DegenDave445/status/"]').first().getAttribute('href').catch(()=>null);
    posts.push({ text: text.slice(0,200), url: href ? 'https://x.com'+href.split('?')[0].replace(/\/analytics$/,'') : null });
  }
  console.log('recent posts:', JSON.stringify(posts, null, 2));

  const found = posts.find(p => /INUX|trench life/i.test(p.text||''));
  let outboundUrl = found?.url || null;

  if (!found) {
    console.log('Outbound missing — posting now');
    // Use home compose button for reliability
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    await page.locator('[data-testid="SideNav_NewTweet_Button"]').click({ timeout: 15000 });
    await sleep(1500);
    const box = page.locator('[data-testid="tweetTextarea_0"]').first();
    await box.click({ timeout: 15000 });
    // clear any draft
    await page.keyboard.press('Control+A');
    await page.keyboard.type(OUTBOUND, { delay: 8 });
    await sleep(1000);
    const btn = page.locator('[data-testid="tweetButton"]').first();
    const disabled = await btn.getAttribute('aria-disabled').catch(()=>null);
    console.log('tweetButton disabled?', disabled);
    await btn.click({ timeout: 15000 });
    await sleep(5000);

    // re-scan profile
    await page.goto('https://x.com/DegenDave445', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3500);
    const arts2 = page.locator('article[data-testid="tweet"]');
    const n2 = Math.min(await arts2.count(), 5);
    for (let i=0;i<n2;i++) {
      const art = arts2.nth(i);
      const text = (await art.locator('[data-testid="tweetText"]').innerText().catch(()=>''));
      const href = await art.locator('a[href*="/DegenDave445/status/"]').first().getAttribute('href').catch(()=>null);
      const url = href ? 'https://x.com'+href.split('?')[0].replace(/\/analytics$/,'') : null;
      console.log('post', i, url, text.slice(0,120));
      if (/INUX|trench life/i.test(text)) outboundUrl = url;
    }
  }

  // Fix engagement reply URLs from with_replies
  await page.goto('https://x.com/DegenDave445/with_replies', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  const replies = [];
  const rArts = page.locator('article[data-testid="tweet"]');
  const rn = Math.min(await rArts.count(), 12);
  for (let i=0;i<rn;i++) {
    const art = rArts.nth(i);
    const text = (await art.locator('[data-testid="tweetText"]').innerText().catch(()=>'')).slice(0,160);
    // get status link that is OUR status
    const links = await art.locator('a[href*="/DegenDave445/status/"]').evaluateAll(els =>
      els.map(e => e.getAttribute('href')).filter(Boolean)
    );
    const clean = [...new Set(links.map(h => 'https://x.com'+h.split('?')[0].replace(/\/(analytics|photo\/\d+)$/,'')))];
    replies.push({ text, urls: clean });
  }
  console.log('replies:', JSON.stringify(replies, null, 2));

  const socialPath = '/workspace/survival-trading/artifacts/cycle_029_social.json';
  const social = JSON.parse(fs.readFileSync(socialPath, 'utf8'));
  if (outboundUrl) {
    social.outboundPost = { url: outboundUrl, text: OUTBOUND, verified: true };
  } else {
    social.blockers = social.blockers || [];
    social.blockers.push('outbound post not found after retry');
  }

  // Remap engagements by matching reply text
  for (const e of social.engagements || []) {
    const match = replies.find(r => r.text && e.text && r.text.includes(e.text.slice(0,40)));
    if (match && match.urls[0]) e.replyUrl = match.urls[0];
  }
  // also capture bitecong / keylo / PumpfunEco specifically
  social.recentReplies = replies.slice(0,8);
  social.unrepliedLeft = (social.mentions||[]).filter(m => !m.alreadyReplied && !m.replied).length;
  fs.writeFileSync(socialPath, JSON.stringify(social, null, 2));
  console.log('OUTBOUND', outboundUrl);
  console.log('updated social saved');
  await browser.close().catch(()=>{});
})();
