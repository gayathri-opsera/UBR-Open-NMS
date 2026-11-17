import json,re,urllib.request,time
T=json.load(open('login.json'))['data']['accessToken']
objs=json.load(open('mib_objects.json'))
PRE=('wireless','link','dcs','ethernet','network','vlan','sys','radius','dhcp','snmp','gps','ntp','eth','ssh','telnet','http','https','syslog','temp','filtering','dfs','leds','qinq','hsb')
SKIP=re.compile(r'(password|secret|key$|Password|Key$)',re.I)
def rows_for(o):
    t=o['indexType']; n=o['name']
    if t=='SCALAR': return ['0']
    if t=='SINGLE_INDEX': return ['1','2','3']
    if t=='DOUBLE_INDEX': return ['1.1','2.1','3.1']
    return []
want=[]
meta={}
for o in objs:
    if not o['name'].startswith(PRE) or not o.get('oid') or SKIP.search(o['name']): continue
    if o['name'].startswith('assoc'): continue
    for r in rows_for(o):
        oid=f"{o['oid']}.{r}"; want.append(oid); meta[oid]=(o['name'],r)
print(len(want),'OIDs requested')
res={}
def post(oids):
    req=urllib.request.Request('http://localhost:5173/api/node-view/2641XCT0026K/snmp-get',method='POST',data=json.dumps({'oids':oids}).encode(),headers={'Authorization':'Bearer '+T,'content-type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=90))['data']['results']
for i in range(0,len(want),40):
    chunk=want[i:i+40]
    try:
        for r in post(chunk): res[r['oid']]=r['value']
    except Exception as e: print('chunk',i,'failed:',e)
    time.sleep(0.8)
out=[{'name':meta[o][0],'row':meta[o][1],'oid':o,'value':v} for o,v in res.items() if v is not None]
json.dump(out,open('snmp_values.json','w'),indent=1)
print(len(out),'OIDs answered by the device out of',len(want))
