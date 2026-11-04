import { chromium } from 'playwright-core';
import fs from 'fs';
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9224');
  const context=browser.contexts()[0];
  const page=context.pages().find(p=>(p.url()||'').includes('x.com'))||await context.newPage();
  await page.goto('https://x.com/DegenDave445/with_replies',{waitUntil:'domcontentloaded',timeout:60000});
  await sleep(4000);
  // scroll a bit
  await page.mouse.wheel(0,1200); await sleep(2000);
  const arts=page.locator('article[data-testid="tweet"]');
  const n=Math.min(await arts.count(),20);
  const found=[];
  for(let i=0;i<n;i++){
    const art=arts.nth(i);
    const text=(await art.locator('[data-testid="tweetText"]').innerText().catch(()=>'')).replace(/\s+/g,' ').trim();
    if(!/GPU pimp|trench bag|one more flip|4090 fan/i.test(text)) continue;
    const hrefs=await art.locator('a[href*="/DegenDave445/status/"]').evaluateAll(els=>els.map(e=>e.getAttribute('href')));
    const urls=[...new Set(hrefs.filter(Boolean).map(h=>'https://x.com'+h.split('?')[0].replace(/\/(analytics|photo\/\d+)$/,'')))];
    found.push({text:text.slice(0,120), urls});
  }
  console.log(JSON.stringify(found,null,2));
  const social=JSON.parse(fs.readFileSync('/workspace/survival-trading/artifacts/cycle_029_social.json','utf8'));
  for(const e of social.engagements){
    const m=found.find(f=>f.text.includes(e.text.slice(0,35)));
    if(m&&m.urls[0]){ e.replyUrl=m.urls[0]; e.urlConfidence='matched_text'; delete e.urlConfidence; }
  }
  // bitecong specifically
  const bite=found.find(f=>/one more flip/i.test(f.text));
  if(bite){
    const e=social.engagements.find(x=>x.target==='@bitecong');
    if(e){ e.replyUrl=bite.urls[0]; delete e.urlConfidence; }
  }
  fs.writeFileSync('/workspace/survival-trading/artifacts/cycle_029_social.json', JSON.stringify(social,null,2)+'\n');
  // update report engagements too
  const report=JSON.parse(fs.readFileSync('/workspace/survival-trading/artifacts/cycle_029_report.json','utf8'));
  report.social=social;
  fs.writeFileSync('/workspace/survival-trading/artifacts/cycle_029_report.json', JSON.stringify(report,null,2)+'\n');
  console.log('engagements:', social.engagements.map(e=>({t:e.target,u:e.replyUrl})));
  await browser.close().catch(()=>{});
})();
