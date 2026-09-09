'use strict';
// Browser-hosted fallback for systems that prohibit launching a headless browser.
// Binds loopback only; uses synthetic members and disables all DB/LLM connections.
const http=require('node:http'), fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const port=Number(process.env.PORT||43189);
let lastResult={status:'not started'};

async function runBrowserChecks(){
  const report=document.querySelector('pre'), results=[];
  function log(value){report.textContent=JSON.stringify(value,null,2);}
  function assert(value,message){if(!value)throw Error(message);}
  function snapshot(doc,selector){
    const node=doc.querySelector(selector),win=doc.defaultView;
    const tree=[node,...node.querySelectorAll('*')].filter(el=>!['SCRIPT','STYLE'].includes(el.tagName)).map(el=>{
      const rect=el.getBoundingClientRect(),style=win.getComputedStyle(el);
      return {tag:el.tagName,attrs:[...el.attributes].map(a=>[a.name,a.name==='class'?a.value.trim():a.value]).sort((a,b)=>a[0].localeCompare(b[0])),text:el.children.length?'':el.textContent,rect:[rect.x,rect.y,rect.width,rect.height],style:[...style].map(k=>[k,style.getPropertyValue(k)]),before:win.getComputedStyle(el,'::before').cssText,after:win.getComputedStyle(el,'::after').cssText};
    });
    // Baseline is served under a separate URL; the underlying assets are identical.
    return JSON.parse(JSON.stringify(tree).replaceAll('/baseline/','/'));
  }
  function compare(a,b,label){
    assert(a.length===b.length,label+' element count '+a.length+' vs '+b.length);
    for(let i=0;i<a.length;i++){
      if(JSON.stringify(a[i])!==JSON.stringify(b[i])){
        const changed=Object.keys(a[i]).filter(k=>JSON.stringify(a[i][k])!==JSON.stringify(b[i][k]));
        const styleDiff=changed.includes('style')?a[i].style.filter((v,j)=>JSON.stringify(v)!==JSON.stringify(b[i].style[j])).slice(0,4):[];
        throw Error(label+' mismatch element '+i+' '+a[i].tag+' '+JSON.stringify(a[i].attrs)+' keys '+changed.join(',')+' style '+JSON.stringify(styleDiff));
      }
    }
  }
  async function open(file,width,baseline){
    const frame=document.createElement('iframe');frame.style.cssText='border:0;width:'+width+'px;height:900px;display:block;';
    frame.src='/'+(baseline?'baseline/':'')+file;document.querySelector('#frames').append(frame);
    await new Promise(resolve=>frame.onload=resolve);
    await new Promise(resolve=>setTimeout(resolve,2000));
    await frame.contentDocument.fonts.ready;
    const css=frame.contentDocument.createElement('style');css.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';frame.contentDocument.head.append(css);
    return frame;
  }
  try{
    for(const width of [390,1280]){
      for(const file of ['index.html','admin.html']){
        const before=await open(file,width,true),after=await open(file,width,false);
        compare(snapshot(before.contentDocument,'body'),snapshot(after.contentDocument,'body'),file+' entry '+width);
        results.push({file,width,entryDOMLayoutStylesIdentical:true});before.remove();
        if(file==='index.html'){
          const win=after.contentWindow,doc=after.contentDocument;
          for(const qtype of ['career','dating_possibility','past_life_connection']){
            win.fixtureRender(qtype);
            await new Promise(resolve=>setTimeout(resolve,350));await doc.fonts.ready;
            const initial=snapshot(doc,'#resultScreen');
            win.PJArchiveSecurity.restore(doc.querySelector('#cards'),doc.querySelector('#reading'),doc.querySelector('#cards').innerHTML,doc.querySelector('#reading').innerHTML);
            compare(initial,snapshot(doc,'#resultScreen'),qtype+' restored '+width);
            if(qtype==='past_life_connection'){
              doc.querySelector('[data-action="destiny-story-next-v203"]').click();
              assert(doc.querySelector('.destiny-story-slide-v203.active details[open]'),'Next story must remain open');
            }
            results.push({qtype,width,archiveDOMLayoutStylesIdentical:true});
          }
          win.__archiveAttack=0;
          const attack='<img src="missing" onerror="window.__archiveAttack=1"><svg onload="window.__archiveAttack=2"></svg><a href="javascript:window.__archiveAttack=3">link</a><script>window.__archiveAttack=4<\/script><iframe srcdoc="bad"></iframe><style>body{display:none}</style>';
          win.PJArchiveSecurity.restore(doc.querySelector('#cards'),doc.querySelector('#reading'),attack,attack+'<details open><summary>안전한 제목</summary><p class="master-note" style="color: rgb(12, 34, 56)" data-test="safe">기존 문장</p><input type="checkbox" checked></details>');
          await new Promise(resolve=>setTimeout(resolve,100));
          assert(!doc.querySelector('#resultScreen').querySelector('script,iframe,style,[onerror],[onload],[srcdoc],[href^="javascript:"]'),'unsafe markup remains');
          assert(win.__archiveAttack===0,'attack executed');
          assert(doc.querySelector('details[open] input:checked'),'checkbox/details state lost');
          const clean=doc.querySelector('#reading').innerHTML,purifier=win.DOMPurify;delete win.DOMPurify;
          let closed=false;try{win.PJArchiveSecurity.restore(doc.querySelector('#cards'),doc.querySelector('#reading'),attack,attack)}catch(_){closed=doc.querySelector('#reading').innerHTML===clean;}
          win.DOMPurify=purifier;assert(closed,'sanitizer failure did not fail closed');
          results.push({width,xssBlocked:true,failClosed:true,checkboxPreserved:true});
        }
        after.remove();log({status:'running',results});
      }
    }
    const result={status:'passed',results};log(result);await fetch('/__results',{method:'POST',body:JSON.stringify(result)});
  }catch(error){const result={status:'failed',error:error.message,results};log(result);await fetch('/__results',{method:'POST',body:JSON.stringify(result)});}
}

const seed=`<script>
const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...a){super(...(a.length?a:[1788912000000]));}static now(){return 1788912000000}};
let fixtureSeed=42;Math.random=()=>{fixtureSeed=fixtureSeed*16807%2147483647;return fixtureSeed/2147483647};
localStorage.clear();sessionStorage.clear();localStorage.setItem('pjoa_members',JSON.stringify([{id:'security_fixture',password:'fixture-only',tier:'member',status:'active',plan:'permanent',permanent:true,paid:true,expiresAt:4102444800000,history:[]}]));
window.supabase={createClient:()=>null};
window.fixtureRender=function(qtype){
currentUser={type:'member',id:'security_fixture',tier:'member',expiresAt:4102444800000};
const question=qtype==='past_life_connection'?'전생에서 이어진 인연이 이번생에서도 나타날까?':qtype==='dating_possibility'?'이 관계가 연애로 발전할 수 있을까?':'일의 흐름은 어떨까?';
$('question').value=question;$('question').dataset.qtype=qtype;window.selectedReadingQuestionV75={qtype,type:qtype,question};window.selectedLoveQuestionV60={qtype,type:qtype,question};
const cards=tarotDeck.slice(0,3).map((c,i)=>({...c,rev:i===1,position:['현재','흐름','조언'][i]}));renderCards(cards);renderReading(cards);show('resultScreen');};
</script>`;

http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'self'");
  const url=new URL(req.url,'http://127.0.0.1:'+port);
  if(url.pathname==='/__results'){
    if(req.method==='POST'){let body='';req.on('data',x=>{body+=x;if(body.length>100000)req.destroy()});req.on('end',()=>{lastResult=JSON.parse(body);console.log(JSON.stringify(lastResult));res.end('ok')});return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(lastResult));return;
  }
  if(url.pathname==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'");
    res.end('<!doctype html><meta charset="utf-8"><h1>Local security QA — synthetic data only</h1><pre>Running…</pre><div id="frames"></div><script>('+runBrowserChecks.toString()+')()<\/script>');return;
  }
  if(url.pathname.startsWith('/.netlify/')){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"fixture only"}');return;}
  const baseline=url.pathname.startsWith('/baseline/');
  const relative=decodeURIComponent(url.pathname.replace(/^\/(baseline\/)?/,''));
  const target=path.resolve(root,'outputs',relative);
  if(!target.startsWith(path.join(root,'outputs')+path.sep)||!fs.existsSync(target)||fs.statSync(target).isDirectory()){res.writeHead(404);res.end();return;}
  let body=fs.readFileSync(target);
  if(relative.endsWith('.html')){
    let html=baseline?execFileSync('git',['show',(process.env.BASELINE_REF||'c522f2c')+':outputs/'+relative],{cwd:root,maxBuffer:12000000}).toString():body.toString();
    html=html.replace('<head>','<head>'+seed).replace(/<script src="https:\/\/cdn.jsdelivr.net\/npm\/@supabase\/supabase-js@2"><\/script>/g,'');
    html=html.replace(/const CLOUD_ENABLED=[^;]+;/,'const CLOUD_ENABLED=false;').replace("return location.protocol==='http:'||location.protocol==='https:';",'return false;');body=Buffer.from(html);
  }
  const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html; charset=utf-8','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.mp4':'video/mp4'};
  res.setHeader('Content-Type',mime[path.extname(target)]||'application/octet-stream');res.end(body);
}).listen(port,'127.0.0.1',()=>console.log('Offline fixture: http://127.0.0.1:'+port));
