import fs from 'fs'; import {spawn} from 'child_process';
const login=JSON.parse(fs.readFileSync('login.json')).data; const COPY=fs.readFileSync('copy_id','utf8').trim(); const {ids,sec}=JSON.parse(fs.readFileSync('ids.json'));
const port=9500+Math.floor(Math.random()*40);
const chrome=spawn(process.env.HOME+'/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',['--headless=new','--no-sandbox','--remote-debugging-port='+port,'--user-data-dir='+process.cwd()+'/prof'+port,'--window-size=1700,1500','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend={}; ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend[m.id]){pend[m.id](m);delete pend[m.id];}};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend[i]=r;ws.send(JSON.stringify({id:i,method,params}));});
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.result.exceptionDetails?('ERR '+JSON.stringify(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text)):r.result.result?.value;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.confirm=()=>true;window.prompt=()=>null;'});
await send('Page.navigate',{url:'http://localhost:5173/login'}); await wait(2000);
await ev(`localStorage.setItem('nms_tokens',JSON.stringify({accessToken:${JSON.stringify(login.accessToken)},refreshToken:${JSON.stringify(login.refreshToken)},expiresAt:Date.now()+3e7}));localStorage.setItem('nms_user',JSON.stringify({id:'x',username:'admin',email:'a@b.c',role:'Admin',fullName:'Admin'}));1`);
await send('Page.navigate',{url:'http://localhost:5173/v2/mib-builder-v2?id='+COPY}); await wait(6000);
const H=`
const setIn=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
const labs=t=>[...document.querySelectorAll('label')].filter(l=>l.textContent.trim().toLowerCase().startsWith(t.toLowerCase()));
const ctlOf=l=>{let e=l.nextElementSibling; for(let n=0;n<4&&e;n++){ if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)) return e; const q=e.querySelector&&e.querySelector('input,select,textarea'); if(q) return q; e=e.nextElementSibling;} return null;};
const C=(t,i=0)=>{const l=labs(t)[i]; if(!l) throw new Error('no label: '+t); const c=ctlOf(l)||l.querySelector('input'); if(!c) throw new Error('no control for: '+t); return c;};
const BOX=p=>[...document.querySelectorAll('div')].find(b=>b.firstElementChild&&b.firstElementChild.textContent.trim().startsWith(p)&&b.querySelector('label'));
const CB=(box,t,i=0)=>{const l=[...BOX(box).querySelectorAll('label')].filter(l=>l.textContent.trim().toLowerCase().startsWith(t.toLowerCase()))[i]; if(!l) throw new Error('no label '+t+' in '+box); return l;};
const CIN=(box,t,i=0)=>{const l=CB(box,t,i); let e=l.nextElementSibling; for(let n=0;n<4&&e;n++){ if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)) return e; const q=e.querySelector&&e.querySelector('input,select,textarea'); if(q) return q; e=e.nextElementSibling;} throw new Error('no control '+t)};
const QIN=(box,sel,i=0)=>BOX(box).querySelectorAll(sel)[i];
const clickField=id=>document.querySelector('[data-dv-field='+id+']').click();
const btn=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(t));`;
const R=[]; const step=async(name,js,w=500)=>{const r=await ev(`(()=>{${H}; try{ ${js}; return 'ok' }catch(e){ return 'FAIL '+e.message }})()`); R.push([name,r]); await wait(w);};
// navigate the preview: Wireless > Radio 1 > Properties
const nav=`[...document.querySelectorAll('.dv-top-a')].find(a=>a.textContent.includes('Wireless')).click();`;
await step('open Wireless menu',nav,700);
await step('open Radio 1',`[...document.querySelectorAll('.dv-sub li a')].find(a=>a.textContent.trim()==='Radio 1').click()`,700);
// ---- A. template field: every calculation property
await step('select Active Channel (template)',`clickField('${ids.tpl[1]}')`,700);
await step('template text',`setIn(CIN('Field ·','Template —'),'{c} ( [[5950 + 5*{c}]] MHz ) EDITED')`);
await step('fallback',`setIn(CIN('Field ·','If the template cannot be computed'),'{c} fb')`);
await step('input 1 sample',`setIn(QIN('Field ·','input[placeholder=sample]'),'77')`);
await step('input 1 map',`setIn(QIN('Field ·','input[placeholder^="show as, e.g. ap=BTS"]'),'77=SEVENTY7')`);
await step('input 1 strip',`setIn(QIN('Field ·','input[placeholder^="remove text matching"]'),'ZZZ')`);
await step('input name',`setIn(QIN('Field ·','input[placeholder=name]'),'c')`);
await step('input OID',`setIn(QIN('Field ·','input[placeholder^=".1.3.6.1…"]'),'.1.3.6.1.4.1.14125.123.1.1.1.1.1.8.2')`);
await step('label',`setIn(CIN('Field ·','Label (shown'),'Active Channel EDITED')`);
await step('units',`setIn(CIN('Field ·','Units'),'U')`);
await step('hint',`setIn(CIN('Field ·','Hint after the control'),'hint EDITED')`);
// ---- B. select field with options
await step('select Link Type',`clickField('${ids.sel[1]}')`,700);
await step('options text',`setIn(CIN('Field ·','Dropdown options'),'1=PTP edited\\n3=PTMP\\n9=Extra')`);
await step('widget',`setIn(CIN('Field ·','Widget'),'Text input')`);
await step('access',`setIn(CIN('Field ·','Access'),'read-only')`);
await step('empty markers',`setIn(CIN('Field ·','Values that mean'),'-1, 0')`);
await step('min',`setIn(CIN('Field ·','Min'),'1')`); await step('max',`setIn(CIN('Field ·','Max'),'9')`);
await step('poll (field)',`setIn(CIN('Field ·','Poll interval (s)'),'45')`);
await step('write mode (field)',`setIn(CIN('Field ·','Write mode'),'direct')`);
await step('confirm before write',`CB('Field ·','Ask for confirmation').querySelector('input').click()`);
// ---- C. static field
await step('select Key (fixed text)',`clickField('${ids.static[1]}')`,700);
await step('fixed value',`setIn(CIN('Field ·','Fixed value'),'MASKED-EDITED')`);
// ---- D. section settings (Radio 1 Properties)
await step('select section (click the row area)',`clickField('${ids.sel[1]}'); const s=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Properties'); true`,500);
await step('section heading',`setIn(CIN('Section ·','Page heading'),'Radio 1 EDITED')`);
await step('section title',`setIn(CIN('Section ·','Section title'),'Props EDITED')`);
await step('section note',`setIn(CIN('Section ·','Note under the form'),'Note: EDITED')`);
await step('section layout',`setIn(CIN('Section ·','Layout'),'card')`);
await step('card column',`setIn(CIN('Section ·','Card column'),'right')`);
await step('hide when empty',`CB('Section ·','Hide this section').querySelector('input').click()`);
await step('section poll',`setIn(CIN('Section ·','Poll interval (s)'),'77')`);
await step('section columns',`setIn(CIN('Section ·','Columns'),'1')`);
await step('full width',`CB('Section ·','Full width').querySelector('input').click()`);
await step('section write mode',`setIn(CIN('Section ·','Write mode (Save button)'),'direct')`);
// ---- E. matrix
await step('go to Summary',`[...document.querySelectorAll('.dv-top-a')].find(a=>a.textContent.includes('Quick Start')).click()`,800);
await step('select matrix row',`clickField('${ids.mxrow[1]}')`,700);
await step('matrix row empty markers',`setIn(CIN('Field ·','Values that mean'),'0, -1, NOPE')`);
await step('select matrix section',`document.querySelector('[data-dv-section=${sec.matrix}]').click()`,700);
await step('column 1 label',`setIn(QIN('Section ·','input[placeholder="Heading, e.g. Radio 2"]'),'R1 EDITED')`);
await step('column 1 map',`setIn(QIN('Section ·','input[placeholder="show as…"]'),'ap=BTS-EDITED')`);
await step('column 1 index',`setIn(QIN('Section ·','input[title^="Table row index"]'),'5')`);
await step('hide empty columns',`CB('Section ·','Hide a column when').querySelector('input').click()`);
await step('+ radio column',`btn('+ Radio column').click()`);
// ---- F. header
await step('header uptime template',`setIn([...BOX('Header bar').querySelectorAll('input')].find(i=>i.value==='{ticks} / 100'),'{ticks} / 200')`);
await step('SAVE',`btn('Save').click()`,3500);
fs.writeFileSync('edit_steps.json',JSON.stringify(R,null,1));
console.log(R.filter(r=>r[1]!=='ok').length+' step(s) could not be done via the UI:'); R.filter(r=>r[1]!=='ok').forEach(r=>console.log('  ',r[0],'->',r[1]));
console.log(R.length-R.filter(r=>r[1]!=='ok').length,'of',R.length,'UI edits performed');
chrome.kill(); process.exit(0);
