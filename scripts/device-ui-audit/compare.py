import json,re,spec,collections
NV=json.load(open('nv_render.json')); WEBUI=json.load(open('device_ui.json'))
DYN={'Local Time':r'^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}$','CPU / Memory':r'^\( [\d.]+ / [\d.]+ \) %$'}
def web_val(page,label,occ):
    key='home' if page=='home' else page.replace('_','/')
    fs=[f for f in WEBUI[key]['fields'] if f['label']==label]
    return fs[occ]['value'] if len(fs)>occ else None
sections=spec.build_sections()
res=[]; seen=collections.defaultdict(int)
def view_for(s):
    k=f"{s['uiPage']} > {s['uiParent']} > {s['uiTab']}"
    return NV.get(k) or NV.get(f"{s['uiPage']} > {s['uiParent']} > ")
HOME={ # Summary expectations copied from the device's Summary page (static text it showed)
 'Model':'UBR660','Hardware Version':'v01','Bootloader Version':'1.4','Temperature':'42.0 °C','GPS':'- -','Elevation':'-','IP Address':'192.168.6.1','Gateway':'192.168.6.1','VLAN Status':'Enabled',
 ('MAC Address',0):'d4:e5:c9:0a:0b:fd',('MAC Address',1):'d4:e5:c9:0a:0b:fe',('Speed / Duplex',0):'Up 1000(Mbps) - full',('Speed / Duplex',1):'Down',('Cable Length',0):'-',('Cable Length',1):'-'}
for s in sections:
    v=view_for(s)
    if s.get('uiLayout')=='matrix': continue
    if v is None: 
        for f in s['fields']: res.append((s['uiTab'],f['label'],'?','(tab not rendered)','FAIL')); 
        continue
    # rows available in this view: form rows (label,value) or card rows of this card
    if s.get('uiLayout')=='card':
        card=[c for c in v['cards'] if c['legend']==s['title']]; rows=card[0]['rows'] if card else []
    else: rows=v['rows']
    cnt=collections.defaultdict(int)
    for f in s['fields']:
        w=f.get('_web'); 
        if not w: continue
        page,label=w[0],w[1]; occ=w[2] if len(w)>2 else 0
        got=[r[1] for r in rows if r[0]==f['label']]
        k=cnt[f['label']]; cnt[f['label']]+=1
        actual=got[k] if len(got)>k else None
        if page=='home': exp=HOME.get((label,occ),HOME.get(label))
        else: exp=web_val(page,label,occ)
        where=f"{s['uiPage']} > {s['uiParent']} > {s['uiTab']}"
        if label in DYN and page=='home' or (label=='Local Time'):
            ok=actual is not None and re.match(DYN[label],actual or '') is not None
            res.append((where,label,exp,actual,'PASS (live value, same format)' if ok else 'DIFF')); continue
        if exp in ('***',) and actual in ('********','••••••••'): res.append((where,label,exp,actual,'PASS (secret masked, never read)')); continue
        if exp is None: res.append((where,label,exp,actual,'NO WEB VALUE')); continue
        e=(exp or '').strip(); a=(actual or '').strip()
        norm=lambda x: '' if x in ('-','—') else x
        res.append((where,label,exp,actual,'PASS' if (a==e or (norm(a)==norm(e) and e in ('','-'))) else 'DIFF'))
# matrices on the Summary page
sumv=NV['Quick Start > Quick Start > ']
EXPM={'Wireless':{'Radio Status':['Enabled','Disabled','Enabled'],'MAC Address':['d6:e5:c9:0a:0c:00','-','d4:e5:c9:0a:0b:ff'],'Link Type':['PTP','-','WI-FI'],'Radio Mode':['BTS','-','AP'],'Bandwidth':['20 MHz','-','20 MHz'],
  'SSID':['UBR660_R1_TEST','-','UBRMGMT0A0BFF'],'Configured Channel':['77 (6335 MHz)','-','Auto'],'Active Channel':['77 (6335 MHz)','-','1 (2412 MHz)'],'Security':['Enabled','Enabled','Enabled'],'RTX Percentage':['0 %','-','-'],'Remote Partners':['1','-','0']}}
for m in sumv['matrix']:
    if m['legend']=='Wireless':
        cols=m['cols']
        for r in m['rows']:
            lab=r[0]; exp=EXPM['Wireless'].get(lab)
            for ci,c in enumerate(cols):
                actual=r[1+ci] if len(r)>1+ci else None
                e=exp[ci] if exp else None
                res.append(('Summary > Wireless (radio columns)',f'{lab} · {c}',e,actual,'PASS' if actual==e else 'DIFF'))
    else:
        for r in m['rows']:
            for ci,c in enumerate(m['cols']):
                a=r[1+ci] if len(r)>1+ci else None
                res.append((f"Summary > {m['legend']}",f'{r[0]} · {c}','number 0.00',a,'PASS (live value, same format)' if re.match(r'^\d+\.\d\d$',a or '') else 'DIFF'))
json.dump(res,open('compare_result.json','w'),indent=1)
c=collections.Counter(r[4].split(' ')[0] for r in res)
print(dict(c),'of',len(res))
for r in res:
    if not r[4].startswith('PASS'): print('  %-34s %-26s web=%-28r nv=%-28r %s'%(r[0][:34],r[1][:26],r[2],r[3],r[4]))
