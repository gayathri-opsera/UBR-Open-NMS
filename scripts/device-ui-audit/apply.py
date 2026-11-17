import json,urllib.request,copy,spec
T=json.load(open('login.json'))['data']['accessToken']
ID='606f5d23-ae88-4ee2-96f7-cbad9de8a914'
def call(m,u,b=None):
    r=urllib.request.Request('http://localhost:5173/api/v1/ui-builder'+u,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'Authorization':'Bearer '+T,'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r,timeout=60))['data']
cur=call('GET','/descriptors/'+ID)
# 1. backup of the screen exactly as it is now (unpublished draft)
import sys
if '--no-backup' in sys.argv: bk={'descriptorId':'skipped','status':'-'}
else: bk=call('POST','/descriptors',{'screenName':cur['screenName']+' (backup before value-mapping rebuild)','deviceProfile':cur.get('deviceProfile'),'vendor':cur.get('vendor'),'productFamily':cur.get('productFamily'),
   'mibModule':cur.get('mibModule'),'sections':cur['sections'],'deviceUi':cur.get('deviceUi'),'selectedObjects':cur.get('selectedObjects',[]),'layoutMode':'device'})
print('backup draft:',bk['descriptorId'][:8],bk['status'])
# 2. new sections: the device-mirroring ones from the spec + the existing Monitor / Other sections unchanged
keep=[s for s in cur['sections'] if s.get('uiPage') in ('Monitor','Other')]
new=[]
for s in spec.build_sections():
    s=copy.deepcopy(s)
    for f in s['fields']: f.pop('_web',None)
    new.append(s)
secs=new+keep
for i,s in enumerate(secs): s['order']=i
objs=spec.OBJS; have={o['name'] for o in cur.get('selectedObjects',[])}
sel=cur.get('selectedObjects',[])+[o for n,o in objs.items() if n not in have]
d=call('PUT','/descriptors/'+ID,{'sections':secs,'selectedObjects':sel,'layoutMode':'device'})
print('saved:',len(d['sections']),'sections')
p=call('POST','/descriptors/'+ID+'/publish',{})
print('published:',p['status'],p.get('layoutMode'))
