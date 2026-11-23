"""Usage: python3 apply_dependent_options.py <descriptorId> [--no-backup]   (a UBR655 screen — NOT the UBR660 one: its Radio 1 is 6 GHz, these are the 5 GHz lists)

Add the Link Type -> Radio Mode -> Country -> Bandwidth -> Channel dependent dropdowns (dependent_options.py) to the LIVE UBR default
screen (606f5d23…): edits the 'Properties' field lists of Radio 1, Radio 2 and 2.4 GHz in place, keeps everything else, backs the screen up
first (--no-backup to skip), saves and republishes.  Needs login.json (NMS login response); does not need the device crawl.
Idempotent: running it again just rewrites the same tables."""
import json, sys, copy, uuid, urllib.request
import dependent_options
T = json.load(open('login.json'))['data']['accessToken']
ID = next(a for a in sys.argv[1:] if not a.startswith('--'))
def call(m, u, b=None):
    r = urllib.request.Request('http://localhost:5173/api/v1/ui-builder' + u, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=90))['data']
cur = call('GET', '/descriptors/' + ID)
if '--no-backup' in sys.argv: bk = {'descriptorId': 'skipped', 'status': '-'}
else:
    bk = call('POST', '/descriptors', {'screenName': cur['screenName'] + ' (backup before dependent options)', 'deviceProfile': cur.get('deviceProfile'), 'vendor': cur.get('vendor'),
        'productFamily': cur.get('productFamily'), 'mibModule': cur.get('mibModule'), 'sections': cur['sections'], 'deviceUi': cur.get('deviceUi'),
        'selectedObjects': cur.get('selectedObjects', []), 'layoutMode': 'device'})
print('backup draft:', bk['descriptorId'][:8], bk['status'])
RADIO = {'Radio 1': 1, 'Radio 2': 2, '2.4 GHz Radio': 0}
secs = copy.deepcopy(cur['sections'])
for s in secs:
    if s.get('uiPage') != 'Wireless' or s.get('uiTab') != 'Properties' or s.get('uiParent') not in RADIO: continue
    radio = RADIO[s['uiParent']]
    by = {f.get('mibObject'): f for f in s['fields'] if f.get('mibObject')}
    row = by['wirelessRadioMode']['oid'].rsplit('.', 1)[1] if by.get('wirelessRadioMode') else by['wirelessChannel']['oid'].rsplit('.', 1)[1]
    def make_country():
        return {'fieldId': 'f_' + uuid.uuid4().hex[:8], 'elementType': 'field-label', 'label': 'Country', 'mibObject': 'wirelessCountry',
                'oid': '.1.3.6.1.4.1.14125.123.1.1.1.1.1.4.' + row, 'access': 'read-only', 'uiHidden': True, 'order': 0,
                'widget': 'text', 'valueSource': 'mib', 'labelSource': 'custom', 'labelLevel': 'field'}
    ok = dependent_options.add(s['fields'], radio, make_country)
    for i, f in enumerate(s['fields']): f['order'] = i
    print(s['uiParent'], 'dependent options set' if ok else 'skipped')
d = call('PUT', '/descriptors/' + ID, {'sections': secs, 'layoutMode': 'device'})
print('saved:', len(d['sections']), 'sections')
p = call('POST', '/descriptors/' + ID + '/publish', {})
print('published:', p['status'], p.get('layoutMode'))
