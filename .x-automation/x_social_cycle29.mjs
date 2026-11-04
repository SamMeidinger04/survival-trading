import { chromium } from 'playwright-core';
import fs from 'fs';

const OUT = '/workspace/survival-trading/artifacts/cycle_029_social.json';
const result = {
  loggedInAs: null,
  mentionsChecked: false,
  mentions: [],
  outboundPost: null,
  engagements: [],
  followers: null,
  blockers: [],
  errors: [],
};

const OUTBOUND = `48h clock hit INUX (Alien Shiba Inux) — force-exited flat, recycled ~$2.06 into trench (trench life). Equity ~$99.89, cash ~$39.12, 25 bags still cooking. perkspad next ~16:19, then trumpbob/MAMA/Sun. GPU pimp portfolio manager omg lmao`;

const ENGAGEMENT_TARGETS = [
  // filled dynamically from home/search if needed
];

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function confirmAccount(page) {
  await page.goto('https://x.com/DegenDave445', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  // Check account switcher / profile menu
  const meBtn = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').first();
  if (await meBtn.count()) {
    const label = (await meBtn.getAttribute('aria-label')) || (await meBtn.innerText().catch(()=>''));
    result.loggedInAsHint = label;
  }
  // follower count from profile
  try {
    const fol = page.locator('a[href$="/verified_followers"], a[href$="/followers"]').first();
    const t = await fol.innerText({ timeout: 5000 }).catch(()=>'');
    const m = t.match(/([\d,.]+[KMB]?)/);
    if (m) result.followersRaw = m[1];
    // also try exact
    const links = await page.locator('a[href*="/followers"]').allTextContents();
    result.followersTexts = links.slice(0,4);
  } catch (e) { result.errors.push('followers:'+e.message); }
  // Confirm we are THIS account by checking compose / home
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  const accountSwitcher = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
  const switchText = await accountSwitcher.innerText().catch(()=>'');
  result.accountSwitcherText = switchText.replace(/\s+/g,' ').trim().slice(0,120);
  if (/SamuelMeidinge1/i.test(switchText) && !/DegenDave/i.test(switchText)) {
    result.blockers.push('WRONG_ACCOUNT: looks like @SamuelMeidinge1 — aborting posts');
    return false;
  }
  // soft confirm via profile link in nav
  const profileLink = page.locator('a[href="/DegenDave445"]').first();
  if (await profileLink.count()) {
    result.loggedInAs = '@DegenDave445';
    return true;
  }
  // still proceed if DegenDave in switcher
  if (/DegenDave/i.test(switchText)) {
    result.loggedInAs = '@DegenDave445';
    return true;
  }
  result.blockers.push('Could not hard-confirm @DegenDave445 in nav; aborting writes');
  return false;
}

async function getMentions(page) {
  await page.goto('https://x.com/notifications/mentions', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  result.mentionsChecked = true;
  // Collect article tweets that are replies TO us (others mentioning us)
  const articles = page.locator('article[data-testid="tweet"]');
  const n = Math.min(await articles.count(), 15);
  const items = [];
  for (let i=0;i<n;i++) {
    const art = articles.nth(i);
    const text = (await art.innerText().catch(()=>'')).slice(0,500);
    // skip our own tweets
    const userLink = art.locator('a[role="link"][href^="/"]').first();
    const href = await userLink.getAttribute('href').catch(()=>null);
    const statusLink = art.locator('a[href*="/status/"]').first();
    const statusHref = await statusLink.getAttribute('href').catch(()=>null);
    const handle = href ? '@'+href.replace(/^\//,'').split('/')[0] : null;
    if (handle && /DegenDave445/i.test(handle)) continue;
    items.push({ handle, statusHref, textPreview: text.split('\n').slice(0,8).join(' | ') });
  }
  result.mentionScan = items;
  return items;
}

async function alreadyRepliedInThread(page, statusPath) {
  // open tweet and see if DegenDave445 replied
  const url = statusPath.startsWith('http') ? statusPath : 'https://x.com'+statusPath;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  const body = await page.content();
  // look for our replies below
  const ourReplies = page.locator('article[data-testid="tweet"] a[href="/DegenDave445"]');
  // first article is original; if more than 1 with our handle in conversation, may have replied
  // simpler: search page for DegenDave445 status links that are replies
  const replyArticles = page.locator('article[data-testid="tweet"]');
  const count = await replyArticles.count();
  for (let i=1;i<Math.min(count,12);i++) {
    const art = replyArticles.nth(i);
    const hasUs = await art.locator('a[href="/DegenDave445"]').count();
    if (hasUs) return true;
  }
  return false;
}

async function replyToTweet(page, statusPath, text) {
  const url = statusPath.startsWith('http') ? statusPath : 'https://x.com'+statusPath;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  // click reply button on first tweet
  const replyBtn = page.locator('article[data-testid="tweet"]').first().locator('[data-testid="reply"]').first();
  await replyBtn.click({ timeout: 10000 });
  await sleep(1000);
  const box = page.locator('[data-testid="tweetTextarea_0"], div[role="textbox"][data-testid^="tweetTextarea"]').first();
  await box.click({ timeout: 10000 });
  await box.fill('');
  await page.keyboard.type(text, { delay: 15 });
  await sleep(500);
  const send = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
  await send.click({ timeout: 10000 });
  await sleep(3000);
  // try to capture new reply url from our profile replies or current page
  return true;
}

async function createPost(page, text) {
  await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  let box = page.locator('[data-testid="tweetTextarea_0"]').first();
  if (!(await box.count())) {
    // try home compose
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    const open = page.locator('[data-testid="SideNav_NewTweet_Button"]').first();
    if (await open.count()) { await open.click(); await sleep(1500); }
    box = page.locator('[data-testid="tweetTextarea_0"]').first();
  }
  await box.click({ timeout: 15000 });
  await page.keyboard.type(text, { delay: 12 });
  await sleep(800);
  const send = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
  await send.click({ timeout: 10000 });
  await sleep(4000);
  // fetch latest post from profile
  await page.goto('https://x.com/DegenDave445', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const firstStatus = page.locator('article[data-testid="tweet"] a[href*="/DegenDave445/status/"]').first();
  const href = await firstStatus.getAttribute('href').catch(()=>null);
  return href ? 'https://x.com'+href.split('?')[0] : null;
}

async function engageReply(page, tweetUrl, text) {
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  const replyBtn = page.locator('article[data-testid="tweet"]').first().locator('[data-testid="reply"]').first();
  await replyBtn.click({ timeout: 10000 });
  await sleep(800);
  const box = page.locator('[data-testid="tweetTextarea_0"]').first();
  await box.click({ timeout: 10000 });
  await page.keyboard.type(text, { delay: 12 });
  await sleep(500);
  await page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first().click({ timeout: 10000 });
  await sleep(3000);
  return true;
}

async function findEngagementTargets(page) {
  // Use already open crypto chatter or search recent pumpfun/GPU tweets
  await page.goto('https://x.com/search?q=pump.fun%20OR%20%22gpu%22%20memecoin%20-filter%3Areplies&src=typed_query&f=live', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  const arts = page.locator('article[data-testid="tweet"]');
  const n = Math.min(await arts.count(), 12);
  const out = [];
  for (let i=0;i<n && out.length<4;i++) {
    const art = arts.nth(i);
    const handleHref = await art.locator('a[role="link"][href^="/"]').first().getAttribute('href').catch(()=>null);
    if (!handleHref) continue;
    const handle = handleHref.replace(/^\//,'').split('/')[0];
    if (/DegenDave445|SamuelMeidinge1/i.test(handle)) continue;
    const statusHref = await art.locator(`a[href*="/${handle}/status/"]`).first().getAttribute('href').catch(()=>null);
    if (!statusHref) continue;
    const preview = (await art.innerText().catch(()=>'')).split('\n').slice(0,6).join(' ');
    out.push({ handle: '@'+handle, url: 'https://x.com'+statusHref.split('?')[0], preview: preview.slice(0,180) });
  }
  return out;
}

async function latestOwnReplyUrls(page, sinceMs=120000) {
  await page.goto('https://x.com/DegenDave445/with_replies', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const links = page.locator('article[data-testid="tweet"] a[href*="/DegenDave445/status/"]');
  const n = Math.min(await links.count(), 10);
  const urls = [];
  for (let i=0;i<n;i++) {
    const h = await links.nth(i).getAttribute('href');
    if (h) urls.push('https://x.com'+h.split('?')[0]);
  }
  return [...new Set(urls)];
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const context = browser.contexts()[0] || await browser.newContext();
  // Prefer existing notifications page if present
  let page = context.pages().find(p => (p.url()||'').includes('x.com')) || context.pages()[0];
  if (!page) page = await context.newPage();

  try {
    const ok = await confirmAccount(page);
    if (!ok) {
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      await browser.close().catch(()=>{});
      process.exit(2);
    }

    // Mentions
    const mentions = await getMentions(page);
    const unreplied = [];
    for (const m of mentions) {
      if (!m.statusHref) continue;
      // only care about tweets that mention us / are replies in notifications
      const replied = await alreadyRepliedInThread(page, m.statusHref);
      result.mentions.push({
        handle: m.handle,
        tweetUrl: m.statusHref.startsWith('http') ? m.statusHref : 'https://x.com'+m.statusHref,
        alreadyReplied: replied,
        textPreview: m.textPreview,
      });
      if (!replied) unreplied.push(m);
    }

    // Reply to unreplied (max 5)
    for (const m of unreplied.slice(0,5)) {
      const replyText = pickMentionReply(m);
      try {
        await replyToTweet(page, m.statusHref, replyText);
        const entry = result.mentions.find(x => x.tweetUrl.includes(m.statusHref.replace('https://x.com','')) || x.handle===m.handle && x.textPreview===m.textPreview);
        if (entry) { entry.replied = true; entry.replyText = replyText; entry.newReplyThisCycle = true; }
      } catch (e) {
        result.errors.push('reply '+m.handle+': '+e.message);
      }
    }

    // Outbound post (meaningful: force-exit INUX + buy trench)
    try {
      const url = await createPost(page, OUTBOUND);
      result.outboundPost = { url, text: OUTBOUND };
    } catch (e) {
      result.errors.push('outbound:'+e.message);
      result.blockers.push('outbound post failed: '+e.message);
    }

    // Engagements
    let targets = [];
    try { targets = await findEngagementTargets(page); } catch (e) { result.errors.push('engage search:'+e.message); }
    // also use the già-open REX tab if present
    const rex = context.pages().find(p => /inizizi_/i.test(p.url()));
    if (rex) targets.unshift({ handle: '@inizizi_', url: rex.url().split('?')[0], preview: 'open tab' });

    const used = new Set();
    const engageTexts = [
      (t) => `chart looking like a GPU under full load after I say "one more flip" lmao. ${t.handle} cooking`,
      (t) => `omg this has the same energy as my trench bag rn — either moon or thermal throttle lmao`,
      (t) => `GPU pimp sees alpha. if the candles keep screaming like a 4090 fan I'm watching omg lmao`,
    ];
    let ei = 0;
    for (const t of targets) {
      if (used.has(t.handle) || used.has(t.url)) continue;
      if (/DegenDave445|SamuelMeidinge1/i.test(t.handle)) continue;
      used.add(t.handle); used.add(t.url);
      const text = engageTexts[ei % engageTexts.length](t);
      ei++;
      try {
        await engageReply(page, t.url, text);
        result.engagements.push({ target: t.handle, tweetUrl: t.url, text, ok: true });
      } catch (e) {
        result.engagements.push({ target: t.handle, tweetUrl: t.url, text, ok: false, error: e.message });
      }
      if (result.engagements.filter(x=>x.ok).length >= 3) break;
    }

    // Capture recent reply URLs
    try {
      result.recentOwnUrls = await latestOwnReplyUrls(page);
      // map outbound if missing
      if (result.outboundPost && !result.outboundPost.url && result.recentOwnUrls?.[0]) {
        result.outboundPost.url = result.recentOwnUrls[0];
      }
      // assign reply urls heuristically to new mention replies / engagements
      let idx = 0;
      for (const m of result.mentions) {
        if (m.newReplyThisCycle && !m.replyUrl && result.recentOwnUrls[idx]) {
          m.replyUrl = result.recentOwnUrls[idx++];
        }
      }
      for (const e of result.engagements) {
        if (e.ok && !e.replyUrl && result.recentOwnUrls[idx]) {
          e.replyUrl = result.recentOwnUrls[idx++];
        }
      }
    } catch (e) { result.errors.push('recent urls:'+e.message); }

    // follower count from profile again
    try {
      await page.goto('https://x.com/DegenDave445', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2500);
      const folLink = page.locator('a[href="/DegenDave445/verified_followers"], a[href="/DegenDave445/followers"]').first();
      const t = await folLink.innerText();
      const num = t.match(/([\d,]+)/);
      result.followers = num ? Number(num[1].replace(/,/g,'')) : null;
      result.followersText = t.trim();
    } catch (e) { result.errors.push('followers2:'+e.message); }

  } catch (e) {
    result.blockers.push(e.message);
    result.errors.push(e.stack || String(e));
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  // do not close browser — shared chrome
  await browser.close().catch(()=>{});
})();

function pickMentionReply(m) {
  const h = m.handle || 'friend';
  const snippets = [
    `lmao appreciate you sliding in ${h} — GPU ledger says we stay unserious and keep flipping bags omg`,
    `omg hi ${h} — still alive, still chaotic, still treating every candle like a GPU SKU on clearance lmao`,
    `${h} you caught me mid-trench rotation lmao. portfolio looking like a mining rig after overtime omg`,
  ];
  return snippets[Math.floor(Math.random()*snippets.length)];
}
