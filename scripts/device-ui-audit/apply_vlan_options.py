"""Usage: python3 apply_vlan_options.py <descriptorId> [--no-backup]   (a UBR655 screen)

Item 3 (VLAN tab), mirroring the device's own VLAN page (get_vlan_mode_elements):
  - Mode follows Radio 1's Radio Mode: a BTS ('ap') offers Transparent only, a CPE ('sta') Transparent / Access / Trunk / Q-in-Q
  - Access VLAN ID shows only in Access mode (1-4094), Trunk Option only in Trunk mode
  - Trunk VLAN IDs (Trunk mode + Option 'List'): a list editor, up to 100 ids (1-4094). Read from the device's VLAN page; Apply sends one
    SNMP SET per id (vlanTrunkIdDelete for removed ids, then vlanTrunkId for new ones); the delete object is a hidden field
Edits the 'VLAN' tab (Network > VLAN) of the LIVE screen in place, backs it up first, saves and republishes.  Idempotent.
Needs login.json (NMS login response).  Nothing is sent to any device."""
import json, sys, copy, uuid, urllib.request
T = json.load(open('login.json'))['data']['accessToken']
ID = next(a for a in sys.argv[1:] if not a.startswith('--'))
B = '.1.3.6.1.4.1.14125.123.1.1.4'
MODE_TABLE = {'ap': '0(Transparent)', 'sta': '0(Transparent),1(Access),2(Trunk),3(Q-in-Q)'}
def call(m, u, b=None):
    r = urllib.request.Request('http://localhost:5173/api/v1/ui-builder' + u, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=90))['data']
cur = call('GET', '/descriptors/' + ID)
secs = copy.deepcopy(cur['sections'])
rm = next((f for s in secs if s.get('uiPage') == 'Wireless' and s.get('uiParent') == 'Radio 1' and s.get('uiTab') == 'Properties'
           for f in s['fields'] if f.get('mibObject') == 'wirelessRadioMode'), None)
if not rm: sys.exit('Radio 1 > Properties has no Radio Mode field')
in_tab = lambda s: s.get('uiPage') == 'Network' and s.get('uiParent') == 'VLAN' and s.get('uiTab') == 'VLAN'
tab = [s for s in secs if in_tab(s)]
prim = next((s for s in tab if any(f.get('mibObject') == 'vlanMode' for f in s['fields'])), None)
if not prim: sys.exit('no VLAN Mode section on Network > VLAN')
if '--no-backup' in sys.argv: bk = {'descriptorId': 'skipped', 'status': '-'}
else:
    bk = call('POST', '/descriptors', {'screenName': cur['screenName'] + ' (backup before VLAN options)', 'deviceProfile': cur.get('deviceProfile'), 'vendor': cur.get('vendor'),
        'productFamily': cur.get('productFamily'), 'mibModule': cur.get('mibModule'), 'sections': cur['sections'], 'deviceUi': cur.get('deviceUi'),
        'selectedObjects': cur.get('selectedObjects', []), 'layoutMode': 'device'})
print('backup draft:', bk['descriptorId'][:8], bk['status'])
# gather the fields already built on this tab (also the duplicates), then keep one section
MINE = ('vlanMode', 'vlanAccessId', 'vlanTrunkOption', 'vlanTrunkId', 'vlanTrunkIdDelete')
have = {}
for s in tab:
    for f in s['fields']:
        if f.get('mibObject') in MINE: have.setdefault(f['mibObject'], f)
def fld(name, label, oid, **kw):
    f = have.get(name) or {'fieldId': 'f_' + uuid.uuid4().hex[:8], 'elementType': 'field-label', 'label': label, 'labelLevel': 'field', 'mibObject': name,
                           'oid': oid, 'syntax': 'INTEGER', 'access': 'read-write', 'pollInterval': 30, 'confirmWrite': False}
    f.update(kw); return f
mode = fld('vlanMode', 'Mode', B + '.2', widget='Dropdown', enumMap={'0': 'Transparent', '1': 'Access', '2': 'Trunk', '3': 'Q-in-Q'},
           optionsBy={'dependsOn': [rm['fieldId']], 'table': MODE_TABLE})
acc = fld('vlanAccessId', 'Access VLAN ID', B + '.4', widget='Text input', minValue=1, maxValue=4094, helpText='(1 - 4094 )',
          uiShowWhen=[{'field': mode['fieldId'], 'in': ['1']}])
trk = fld('vlanTrunkOption', 'Trunk Option', B + '.5', widget='Dropdown', enumMap={'1': 'List', '2': 'All'},
          uiShowWhen=[{'field': mode['fieldId'], 'in': ['2']}])
ids = fld('vlanTrunkId', 'Trunk VLAN IDs', B + '.6', widget='Text input', minValue=1, maxValue=4094, helpText='(1 - 4094, up to 100 entries)',
          idList={'deleteParam': 'vlanTrunkIdDelete', 'max': 100, 'minId': 1, 'maxId': 4094},
          uiShowWhen=[{'field': mode['fieldId'], 'in': ['2']}, {'field': trk['fieldId'], 'in': ['1']}])
dele = fld('vlanTrunkIdDelete', 'Trunk VLAN ID Delete', B + '.15', widget='Text input', minValue=1, maxValue=4094, uiHidden=True)
prim['fields'] = [mode, acc, trk, ids, dele]
for i, f in enumerate(prim['fields']): f['order'] = i
prim['writeMode'] = 'apply-button'
secs = [s for s in secs if not (in_tab(s) and s is not prim and all(f.get('mibObject') in MINE for f in s['fields']))]
print('VLAN tab sections:', len([s for s in secs if in_tab(s)]), '| fields:', [f['label'] for f in prim['fields']])
d = call('PUT', '/descriptors/' + ID, {'sections': secs, 'layoutMode': 'device'})
print('saved:', len(d['sections']), 'sections')
p = call('POST', '/descriptors/' + ID + '/publish', {})
print('published:', p['status'], p.get('layoutMode'))
