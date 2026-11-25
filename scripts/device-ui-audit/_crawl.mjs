import fs from 'fs'; import {spawn} from 'child_process';
const [,, out, devId] = process.argv; const login=JSON.parse(fs.readFileSync('login.json')).data;
const port=9420+Math.floor(Math.random()*40);
const chrome=spawn(process.env.HOME+'/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',['--headless=new','--no-sandbox','--remote-debugging-port='+port,'--user-data-dir='+out+'/prof'+port,'--window-size=1700,1400','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend={}; ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend[m.id]){pend[m.id](m);delete pend[m.id];}};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend[i]=r;ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.result.exceptionDetails?('ERR '+JSON.stringify(r.result.exceptionDetails.exception?.description||'')):r.result.result?.value;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__errs=[];window.addEventListener('error',e=>__errs.push(String(e.message)));const ce=console.error;console.error=(...a)=>{__errs.push(a.map(String).join(' ').slice(0,220));ce.apply(console,a)}"}); await send('Page.navigate',{url:'http://localhost:5173/login'}); await wait(2000);
await ev(`localStorage.setItem('nms_tokens',JSON.stringify({accessToken:${JSON.stringify(login.accessToken)},refreshToken:${JSON.stringify(login.refreshToken)},expiresAt:Date.now()+3e7}));localStorage.setItem('nms_user',JSON.stringify({id:'x',username:'admin',email:'a@b.c',role:'Admin',fullName:'Admin'}));1`);
await send('Page.navigate',{url:'http://localhost:5173/v2/devices/'+devId}); await wait(7000);
const EXTRACT=`(()=>{const t=e=>(e&&e.textContent||'').replace(/\\s+/g,' ').trim();
 const val=el=>{const s=el.querySelector('select'); if(s) return s.options[s.selectedIndex]?s.options[s.selectedIndex].text:''; const i=el.querySelector('input:not([type=checkbox])'); if(i) return i.value; const c=el.querySelector('input[type=checkbox]'); if(c) return c.checked?'on':'off'; return t(el);};
 const o={heading:t(document.querySelector('.dv-h2')),rows:[],cards:[],matrix:[],tables:[],note:t(document.querySelector('.dv-note'))};
 document.querySelectorAll('.dv-row').forEach(r=>o.rows.push([t(r.querySelector('.dv-label')),val(r.querySelector('.dv-field'))]));
 document.querySelectorAll('fieldset.dv-card').forEach(f=>{const lg=t(f.querySelector('legend')); const rows=[...f.querySelectorAll('.dv-card-row')].map(r=>[t(r.querySelector('.k')),t(r.querySelector('.v'))]); if(rows.length) o.cards.push({legend:lg,rows}); const mx=f.querySelector('table.dv-mx'); if(mx){o.matrix.push({legend:lg,cols:[...mx.querySelectorAll('thead th')].map(t).filter(Boolean),rows:[...mx.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(t))});}});
 document.querySelectorAll('table.dv-table').forEach(tb=>o.tables.push({heads:[...tb.querySelectorAll('th')].map(t),rows:[...tb.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(t)).slice(0,6)}));
 return JSON.stringify(o);})()`;
const res={};
// a tab is read from the device the first time it is opened (a few seconds on a busy radio): wait for it before looking
const clickEl=async(js)=>{await ev(js); await wait(+process.env.NV_CLICK||2500);};
// enumerate menu: top items -> sub items -> tabs
const tops=JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.dv-top-a')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()))`));
for (let ti=0; ti<tops.length; ti++){
  const topName=tops[ti];
  // open (or select) the top item
  await clickEl(`(()=>{const e=[...document.querySelectorAll('.dv-top-a')][${ti}]; e.click(); return 1})()`);
  const subs=JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.dv-top')][${ti}].querySelectorAll('.dv-sub li a')?[...[...document.querySelectorAll('.dv-top')][${ti}].querySelectorAll('.dv-sub li a')].map(a=>a.textContent.replace(/\\s+/g,' ').trim()):[])`));
  const subList=subs.length?subs:[null];
  for (let si=0; si<subList.length; si++){
    if (subs.length) await clickEl(`(()=>{[...[...document.querySelectorAll('.dv-top')][${ti}].querySelectorAll('.dv-sub li a')][${si}].click(); return 1})()`);
    const tbs=JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.dv-tab a')].map(a=>a.textContent.replace(/[↑↓✕]/g,'').replace(/\\s+/g,' ').trim()))`));
    const tabList=tbs.length?tbs:[null];
    for (let bi=0; bi<tabList.length; bi++){
      if (tbs.length) await clickEl(`(()=>{[...document.querySelectorAll('.dv-tab a')][${bi}].click(); return 1})()`);
      await wait(+process.env.NV_WAIT||5000);
      const key=[topName,subList[si]||topName,tabList[bi]||''].join(' > ');
      try{ res[key]=JSON.parse(await ev(EXTRACT)); }catch(e){ res[key]={error:String(e)}; }
    }
  }
}
res.__errs=await ev('JSON.stringify(window.__errs||[])'); res.__header=await ev(`[...document.querySelectorAll('.dv-header .dv-hd-val, .dv-header .dv-hd-lbl')].map(e=>e.textContent.trim()).join(' | ')`);
fs.writeFileSync(process.env.NV_OUT||'nv_render.json',JSON.stringify(res,null,1)); console.log('captured',Object.keys(res).length-1,'tab views');
chrome.kill(); process.exit(0);
