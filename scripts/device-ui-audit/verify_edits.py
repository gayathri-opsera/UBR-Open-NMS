import json,urllib.request
T=json.load(open('login.json'))['data']['accessToken']; ids=json.load(open('ids.json')); I=ids['ids']; S=ids['sec']
cid=open('copy_id').read().strip()
r=urllib.request.Request('http://localhost:5173/api/v1/ui-builder/descriptors/'+cid,headers={'Authorization':'Bearer '+T})
d=json.load(urllib.request.urlopen(r))['data']
sec={s['sectionId']:s for s in d['sections']}
def fld(k): return [f for f in sec[I[k][0]]['fields'] if f['fieldId']==I[k][1]][0]
R=[]
def chk(name,ok,got=None): R.append((name,ok,got))
t=fld('tpl'); c=t['calc']; i0=c['inputs'][0]
chk('template text',c['template']=='{c} ( [[5950 + 5*{c}]] MHz ) EDITED',c['template'])
chk('template fallback',c['fallback']=='{c} fb',c.get('fallback'))
chk('input sample',i0.get('sample')=='77',i0.get('sample'))
chk('input map',i0.get('map')=={'77':'SEVENTY7'},i0.get('map'))
chk('input strip',i0.get('strip')=='ZZZ',i0.get('strip'))
chk('input name',i0.get('name')=='c',i0.get('name'))
chk('input OID',i0['oid']=='.1.3.6.1.4.1.14125.123.1.1.1.1.1.8.2',i0['oid'])
chk('field label',t['label']=='Active Channel EDITED',t['label'])
chk('units',t.get('units')=='U',t.get('units'))
chk('hint (helpText)',t.get('helpText')=='hint EDITED',t.get('helpText'))
s=fld('sel')
chk('enum options',s['enumMap']=={'1':'PTP edited','3':'PTMP','9':'Extra'},s.get('enumMap'))
chk('widget',s['widget']=='Text input',s['widget'])
chk('access',s['access']=='read-only',s['access'])
chk('empty markers',s.get('emptyValues')==['-1','0'],s.get('emptyValues'))
chk('min',s.get('minValue')==1,s.get('minValue')); chk('max',s.get('maxValue')==9,s.get('maxValue'))
chk('field poll interval',s['pollInterval']==45,s['pollInterval'])
chk('field write mode',s.get('writeMode')=='direct',s.get('writeMode'))
chk('confirm before write',s.get('confirmWrite') is True,s.get('confirmWrite'))
k=fld('static'); chk('fixed text',k['staticValue']=='MASKED-EDITED',k['staticValue'])
r1=sec[S['radio1']]
chk('section heading',r1.get('uiTitle')=='Radio 1 EDITED',r1.get('uiTitle'))
chk('section title',r1['title']=='Props EDITED',r1['title'])
chk('section note',r1.get('uiNote')=='Note: EDITED',r1.get('uiNote'))
chk('section layout',r1.get('uiLayout')=='card',r1.get('uiLayout'))
chk('card column',r1.get('uiColumn')=='right',r1.get('uiColumn'))
chk('hide when empty',r1.get('uiHideWhenEmpty') is True,r1.get('uiHideWhenEmpty'))
chk('section poll interval',r1['pollInterval']==77,r1['pollInterval'])
chk('section columns',r1['columns']==1,r1['columns'])
chk('section full width',r1.get('fullWidth') is True,r1.get('fullWidth'))
chk('section write mode',r1['writeMode']=='direct',r1['writeMode'])
mr=fld('mxrow'); chk('matrix row empty markers',mr.get('emptyValues')==['0','-1','NOPE'],mr.get('emptyValues'))
mx=sec[S['matrix']]['uiMatrix']; col=mx['columns']
chk('matrix column label',col[0]['label']=='R1 EDITED',col[0]['label'])
chk('matrix column map',col[0].get('map')=={'ap':'BTS-EDITED'},col[0].get('map'))
chk('matrix column index',col[0]['index']=='5',col[0]['index'])
chk('matrix hide-empty-columns',mx.get('hideEmptyColumns') is False,mx.get('hideEmptyColumns'))
chk('+ radio column added',len(col)==4,len(col))
ui=d['deviceUi']['sources']['uptime']; chk('header uptime expression',ui.get('expr')=='{ticks} / 200',ui.get('expr'))
ok=sum(1 for x in R if x[1]); print(f'{ok} of {len(R)} edits persisted exactly')
for n,o,g in R:
    if not o: print('  NOT PERSISTED:',n,'->',g)
