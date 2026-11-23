"""Update the UBR default screen (606f5d23…) with the UBR655 Wireless pages: Radio 2, all Radio tabs, mode rules, Radio 2 header badge.
Backs the screen up first (unless --no-backup), replaces the 'Wireless' sections, keeps every other section, saves and publishes.
Needs login.json (NMS login response) and web_parsed.json (build_web_parsed.py)."""
import json, sys, copy, urllib.request
import spec, spec_ubr655
T = json.load(open('login.json'))['data']['accessToken']
ID = '606f5d23-ae88-4ee2-96f7-cbad9de8a914'
def call(m, u, b=None):
    r = urllib.request.Request('http://localhost:5173/api/v1/ui-builder' + u, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=90))['data']
cur = call('GET', '/descriptors/' + ID)
if '--no-backup' in sys.argv: bk = {'descriptorId': 'skipped', 'status': '-'}
else:
    bk = call('POST', '/descriptors', {'screenName': cur['screenName'] + ' (backup before UBR655 update)', 'deviceProfile': cur.get('deviceProfile'), 'vendor': cur.get('vendor'),
        'productFamily': cur.get('productFamily'), 'mibModule': cur.get('mibModule'), 'sections': cur['sections'], 'deviceUi': cur.get('deviceUi'),
        'selectedObjects': cur.get('selectedObjects', []), 'layoutMode': 'device'})
print('backup draft:', bk['descriptorId'][:8], bk['status'])
new = spec_ubr655.wireless_sections()
for s in new:
    for f in s['fields']: f.pop('_web', None)
secs, placed = [], False
for s in cur['sections']:
    if s.get('uiPage') == 'Wireless':
        if not placed: secs += new; placed = True
        continue
    secs.append(s)
if not placed: secs += new
for i, s in enumerate(secs): s['order'] = i
used = {f['mibObject'] for s in new for f in s['fields'] if f.get('mibObject')} | {i['name'] for s in new for f in s['fields'] for i in (f.get('calc') or {}).get('inputs', [])}
have = {o['name'] for o in cur.get('selectedObjects', [])}
sel = cur.get('selectedObjects', []) + [spec.OBJS[n] for n in sorted(used) if n in spec.OBJS and n not in have]
ui = copy.deepcopy(cur.get('deviceUi') or {})
radios = ui.get('radios', [])
if not any(r.get('label') == 'Radio 2' for r in radios):
    radios.insert(1, spec_ubr655.radio2_header(radios[0] if radios else None))
ui['radios'] = radios
d = call('PUT', '/descriptors/' + ID, {'sections': secs, 'selectedObjects': sel, 'deviceUi': ui, 'layoutMode': 'device'})
print('saved:', len(d['sections']), 'sections,', len(radios), 'header radios')
p = call('POST', '/descriptors/' + ID + '/publish', {})
print('published:', p['status'], p.get('layoutMode'))
