'use strict';
// Local fixtures only. Every browser request is intercepted; no production DB/API traffic.
// Set PLAYWRIGHT_MODULE to an installed playwright module when it is not on NODE_PATH.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'pjo-security-qa-'));
const baselineRef = process.env.BASELINE_REF || 'c522f2c';
const results=[];
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.mp4':'video/mp4'};

async function open(browser, file, width, baseline=false) {
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(() => {
    const OriginalDate=Date;
    class FixedDate extends OriginalDate {constructor(...args){super(...(args.length?args:[1788912000000]));} static now(){return 1788912000000;}}
    window.Date=FixedDate;
    let seed=42; Math.random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
    localStorage.setItem('pjoa_members',JSON.stringify([{id:'security_fixture',password:'fixture-only',tier:'member',status:'active',plan:'permanent',permanent:true,paid:true,expiresAt:4102444800000,history:[]}]));
  });
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='fixture.local') {
      if(url.href.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:function(){return null}};'});
      return route.abort();
    }
    if(url.pathname.startsWith('/.netlify/'))return route.fulfill({status:401,contentType:'application/json',body:'{"error":"fixture only"}'});
    const relative=decodeURIComponent(url.pathname).replace(/^\//,'');
    const target=path.resolve(root,'outputs',relative);
    if(!target.startsWith(path.join(root,'outputs')+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    let body=fs.readFileSync(target);
    if(relative.endsWith('.html')) {
      let html=baseline?execFileSync('git',['show',baselineRef+':outputs/'+relative],{cwd:root,maxBuffer:12000000}).toString():body.toString();
      html=html.replace(/const CLOUD_ENABLED=[^;]+;/,'const CLOUD_ENABLED=false;');
      html=html.replace("return location.protocol==='http:'||location.protocol==='https:';",'return false;');
      body=Buffer.from(html);
    }
    return route.fulfill({contentType:mime[path.extname(target)]||'application/octet-stream',body});
  });
  await page.goto('http://fixture.local/'+file,{waitUntil:'load'});
  await page.waitForTimeout(1800);
  await page.evaluate(()=>document.fonts.ready);
  await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'});
  return {context,page,errors};
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const width of [390,1280]) {
      for(const file of ['index.html','admin.html']) {
        const before=await open(browser,file,width,true),after=await open(browser,file,width);
        const a=await before.page.screenshot({animations:'disabled'}),b=await after.page.screenshot({animations:'disabled'});
        fs.writeFileSync(path.join(output,file+'-'+width+'-before.png'),a);
        fs.writeFileSync(path.join(output,file+'-'+width+'-after.png'),b);
        assert.deepEqual(after.errors,before.errors,'new browser errors');
        assert.ok(a.equals(b),file+' '+width+' entry pixels changed');
        results.push({file,width,entryPixelsIdentical:true,baselineErrors:before.errors});
        await before.context.close();
        if(file==='index.html') {
          for(const qtype of ['career','dating_possibility','past_life_connection']) {
            await after.page.evaluate(qtype=>{
              currentUser={type:'member',id:'security_fixture',tier:'member',expiresAt:4102444800000};
              const question=qtype==='past_life_connection'?'전생에서 이어진 인연이 이번생에서도 나타날까?':qtype==='dating_possibility'?'이 관계가 연애로 발전할 수 있을까?':'일의 흐름은 어떨까?';
              $('question').value=question; $('question').dataset.qtype=qtype;
              window.selectedReadingQuestionV75={qtype,type:qtype,question};
              window.selectedLoveQuestionV60={qtype,type:qtype,question};
              const cards=tarotDeck.slice(0,3).map((c,i)=>({...c,rev:i===1,position:['현재','흐름','조언'][i]}));
              renderCards(cards);renderReading(cards);show('resultScreen');
            },qtype);
            await after.page.waitForTimeout(300);
            await after.page.evaluate(()=>document.fonts.ready);
            const region=after.page.locator('#resultScreen');
            const imageBefore=await region.screenshot({animations:'disabled'});
            const restored=await after.page.evaluate(()=>{
              const cardHtml=$('cards').innerHTML,readingHtml=$('reading').innerHTML;
              const controlsBefore=$('reading').querySelectorAll('button,input,textarea,details').length;
              PJArchiveSecurity.restore($('cards'),$('reading'),cardHtml,readingHtml);
              return {controlsBefore,controlsAfter:$('reading').querySelectorAll('button,input,textarea,details').length,removed:DOMPurify.removed.map(x=>x.attribute?.name||x.element?.nodeName)};
            });
            const imageAfter=await region.screenshot({animations:'disabled'});
            fs.writeFileSync(path.join(output,qtype+'-'+width+'-before.png'),imageBefore);
            fs.writeFileSync(path.join(output,qtype+'-'+width+'-after.png'),imageAfter);
            assert.equal(restored.controlsBefore,restored.controlsAfter);
            assert.ok(imageBefore.equals(imageAfter),qtype+' '+width+' snapshot pixels changed: '+JSON.stringify(restored));
            if(qtype==='past_life_connection') {
              const next=after.page.locator('[data-action="destiny-story-next-v203"]').first();
              await next.click();
              assert.equal(await after.page.locator('.destiny-story-slide-v203.active details').first().getAttribute('open'),'');
            }
            results.push({qtype,width,pixelsIdentical:true,...restored});
          }
          const security=await after.page.evaluate(()=>{
            window.__archiveAttack=0;
            const attacks='<img src="missing" onerror="window.__archiveAttack=1"><svg onload="window.__archiveAttack=2"></svg><a href="javascript:window.__archiveAttack=3">link</a><script>window.__archiveAttack=4</script><iframe srcdoc="<script>parent.__archiveAttack=5</script>"></iframe><style>body{display:none}</style>';
            PJArchiveSecurity.restore($('cards'),$('reading'),attacks,attacks+'<details open><summary>안전한 제목</summary><p class="master-note" style="color: rgb(12, 34, 56)" data-test="safe">기존 문장</p><input type="checkbox" checked></details>');
            const unsafe=$('resultScreen').querySelectorAll('script,iframe,style,[onerror],[onload],[srcdoc],[href^="javascript:"]').length;
            const preserved=!!$('reading').querySelector('details[open] input:checked')&&$('reading').querySelector('[data-test="safe"]').style.color==='rgb(12, 34, 56)';
            const clean=$('reading').innerHTML,purifier=window.DOMPurify;delete window.DOMPurify;
            let failedClosed=false;try{PJArchiveSecurity.restore($('cards'),$('reading'),'bad','<img onerror="alert(1)">')}catch(_){failedClosed=$('reading').innerHTML===clean;}
            window.DOMPurify=purifier;
            return {unsafe,preserved,failedClosed,executed:window.__archiveAttack};
          });
          assert.deepEqual(security,{unsafe:0,preserved:true,failedClosed:true,executed:0});
          results.push({width,security});
        }
        await after.context.close();
      }
    }
    console.log(JSON.stringify({output,results},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);console.error('Screenshots:',output);process.exitCode=1;});
