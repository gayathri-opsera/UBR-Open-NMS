import fs from 'fs'; import {spawn} from 'child_process';
const [,, base, cookie, out, ...pages] = process.argv;
const port = 9340 + Math.floor(Math.random()*50);
const chrome = spawn(process.env.HOME+'/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',['--headless=new','--no-sandbox','--ignore-certificate-errors','--remote-debugging-port='+port,'--user-data-dir='+out+'/prof'+port,'--window-size=1500,1100','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend={}; ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend[m.id]){pend[m.id](m);delete pend[m.id];}};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend[i]=r;ws.send(JSON.stringify({id:i,method,params}));});
await send('Network.enable');
await send('Network.setCookie',{name:'sysauth',value:cookie,domain:'192.168.6.1',path:'/cgi-bin/luci/',secure:true});
const EXTRACT = `(()=>{
 const txt=e=>(e.textContent||'').replace(/\\s+/g,' ').trim();
 const o={title:txt(document.querySelector('.page-content h2')||{textContent:''}),fields:[],tables:[],cards:[],header:txt(document.querySelector('.grid-container')||{textContent:''})};
 document.querySelectorAll('.cbi-value').forEach(v=>{ if(v.style.display==='none') return; const l=v.querySelector('.cbi-value-title'); if(!l) return; const c=v.querySelector('select,input:not([type=hidden]),textarea'); let val=null,kind='text';
   if(c){ if(c.tagName==='SELECT'){kind='select';val=c.options[c.selectedIndex]?c.options[c.selectedIndex].text:null;} else if(c.type==='checkbox'){kind='checkbox';val=c.checked?'on':'off';} else {kind='input'; val=c.type==='password'?'***':c.value;} } else {val=txt(v.querySelector('.cbi-value-field')||v);} 
   o.fields.push({label:txt(l),kind,value:val,name:c?(c.name||c.id):null}); });
 document.querySelectorAll('table').forEach(t=>{ const hs=[...t.querySelectorAll('th')].map(txt); const rows=[...t.querySelectorAll('tbody tr, tr')].map(r=>[...r.querySelectorAll('td')].map(txt)).filter(r=>r.length); if(hs.length||rows.length) o.tables.push({headers:hs,rows:rows.slice(0,60)}); });
 document.querySelectorAll('fieldset').forEach(f=>{ const lg=f.querySelector('legend'); o.cards.push({legend:lg?txt(lg):'',text:txt(f).slice(0,600)}); });
 o.panel=txt(document.querySelector('.page-content')||document.body).replace(/document\.write\([^)]*\)/g,'').slice(0,6000);
 return JSON.stringify(o);})()`;
const res={};
for (const p of pages){
  await send('Page.navigate',{url:base+'/admin/'+p});
  await new Promise(r=>setTimeout(r,13000));
  const r=await send('Runtime.evaluate',{expression:EXTRACT,returnByValue:true});
  try{ res[p]=JSON.parse(r.result.result.value);}catch(e){res[p]={error:String(e)};}
  console.log(p,'fields:',res[p].fields?.length,'tables:',res[p].tables?.length);
}
fs.writeFileSync(out+'/pages_'+Date.now()+'.json',JSON.stringify(res,null,1));
chrome.kill(); process.exit(0);
