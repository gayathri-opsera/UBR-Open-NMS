"""Bring the two per-model default screens (UBR655 default UI, UBR660 default UI) in line with the device web UI: every row each device page
shows, in the device's order. Rows with an OID are mapped, rows the SNMP agent has no object for stay in the layout and are empty.
usage: python3 apply_two.py <descriptorId> 655|660        Needs login.json, web_parsed.json (see build_web_parsed.py)."""
import json, sys, copy, uuid, urllib.request
import spec, spec_ubr655
T = json.load(open('login.json'))['data']['accessToken']
ID, MODEL = sys.argv[1], sys.argv[2]
def call(m, u, b=None):
    r = urllib.request.Request('http://localhost:5173/api/v1/ui-builder' + u, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=90))['data']
cur = call('GET', '/descriptors/' + ID)
new = spec_ubr655.wireless_sections(MODEL)
for s in new:
    for f in s['fields']: f.pop('_web', None)
secs, placed = [], False
for s in cur['sections']:
    if s.get('uiPage') == 'Wireless':
        if not placed: secs += new; placed = True
        continue
    secs.append(s)
def tab(parent, name): return [s for s in secs if s.get('uiParent') == parent and s.get('uiTab') == name]
def labels(parent, name): return {f.get('label', '').lower() for s in tab(parent, name) for f in s['fields']}
def clone(parent, name, label, as_label):
    for s in tab(parent, name):
        for f in s['fields']:
            if f.get('label') == label:
                g = copy.deepcopy(f); g['fieldId'] = 'f_' + uuid.uuid4().hex[:8]; g['label'] = as_label; return g
def add(parent, name, field):
    ss = [s for s in tab(parent, name) if s['fields']] or tab(parent, name)
    if field['label'].lower() in labels(parent, name): return
    ss[0]['fields'].append(field)
# Management ▸ System ▸ Location: the page also shows the configured position and distance units
for lab, src in (('Latitude', 'Latitude'), ('Longitude', 'Longitude'), ('Altitude', 'Elevation')):
    g = clone('System', 'GPS', src, lab)
    if g: add('System', 'Location', g)
add('System', 'Location', spec_ubr655.blank('Prioritize actual GPS pulse')); add('System', 'Location', spec_ubr655.blank('Distance Units'))
add('System', 'GPS', spec_ubr655.blank('GNSS Status'))
add('Ethernet', 'LAN 2', spec_ubr655.blank('Bridge'))
if not tab('System', 'Compass'):
    secs.append(spec.section('Management', 'System', 'Compass', 'Compass', [spec_ubr655.blank('Status')], layout='form', heading='System Configuration'))
for s in secs:
    for i, f in enumerate(s['fields']): f['order'] = i
for i, s in enumerate(secs): s['order'] = i
used = {f['mibObject'] for s in new for f in s['fields'] if f.get('mibObject')} | {i['name'] for s in new for f in s['fields'] for i in (f.get('calc') or {}).get('inputs', [])}
have = {o['name'] for o in cur.get('selectedObjects', [])}
sel = cur.get('selectedObjects', []) + [spec.OBJS[n] for n in sorted(used) if n in spec.OBJS and n not in have]
d = call('PUT', '/descriptors/' + ID, {'sections': secs, 'selectedObjects': sel, 'deviceUi': cur.get('deviceUi'), 'layoutMode': 'device'})
print('saved', cur['screenName'], len(d['sections']), 'sections')
p = call('POST', '/descriptors/' + ID + '/publish', {})
print('published:', p['status'])
