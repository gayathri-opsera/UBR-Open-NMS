"""Usage: python3 apply_sheet.py <descriptorId> [--no-backup]   (a UBR655 screen)

Applies Configurations_GUI_R1.xlsx — for the parameters the sheet LISTS only (source of truth: its OIDs, model Dropdown/Text,
Label(raw) values, defaults).  Everything else on the screen is left alone.  Backs the screen up first, saves, republishes; idempotent.
Nothing is sent to any device.  Needs login.json.

Wireless  Radio 1 / Radio 2 (5 GHz):  Country list + Bandwidth/Channel tables for 5011 5012 276 124 5019 356 (Bandwidth labelled HT20 …),
          Key = text 8-63, Maximum SUs (BTS + PTMP), OFDMA + Connectorized Antenna Gain (no OID: fixed default, editable in the builder),
          Spatial Stream options follow DDRS Status, Min/Max/Modulation Index follow Spatial Stream (single MCS0-11, dual MCS12-23),
          Max Data Rate Single MCS0-11 / Dual MCS12-23, ATPC Status, DCS Background Scan, Radio 1 Configured Channel = dropdown
Network   VLAN per radio on the vlanTbl OIDs (.4.18.1.x, row = radio) following the device's VLAN page: Mode options by that radio's
          Radio Mode, rows by mode, trunk list; Ethernet Speed labels + MTU (.5.6.1.4); Mgmt VLAN ID moves to VLAN"""
import json, sys, copy, uuid, re, urllib.request
import dependent_options
T = json.load(open('login.json'))['data']['accessToken']
ID = next(a for a in sys.argv[1:] if not a.startswith('--'))
def call(m, u, b=None):
    r = urllib.request.Request('http://localhost:5173/api/v1/ui-builder' + u, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=90))['data']
nid = lambda: 'f_' + uuid.uuid4().hex[:8]
W = '.1.3.6.1.4.1.14125.123.1.1.1'
VT = '.1.3.6.1.4.1.14125.123.1.1.4.18.1'
def fld(label, mib, oid, widget, **kw):
    f = {'fieldId': nid(), 'elementType': 'field-label', 'label': label, 'labelLevel': 'field', 'mibObject': mib, 'oid': oid, 'syntax': 'INTEGER',
         'access': 'read-write', 'widget': widget, 'pollInterval': 30, 'confirmWrite': False}
    f.update(kw); return f
def static(label, value, widget='Text input', **kw):
    f = {'fieldId': nid(), 'elementType': 'field-label', 'label': label, 'labelLevel': 'field', 'access': 'read-write', 'widget': widget,
         'pollInterval': 30, 'confirmWrite': False, 'valueSource': 'static', 'staticValue': value}
    f.update(kw); return f
def mcs(enum, lo, hi): return {k: v for k, v in enum.items() if k.isdigit() and lo <= int(k) <= hi}
def table_of(enum, lo, hi): return ','.join(f'{k}:{v}' for k, v in mcs(enum, lo, hi).items())
def put(fields, f, after=None, before=None):
    """insert f unless a field of the same label/mib is there; returns the field now on the list"""
    cur = next((x for x in fields if x.get('label') == f['label'] and (x.get('mibObject') == f.get('mibObject'))), None)
    if cur:
        keep = cur['fieldId']; cur.update({k: v for k, v in f.items() if k != 'fieldId'}); cur['fieldId'] = keep; return cur
    i = len(fields)
    for name, off in ((after, 1), (before, 0)):
        if name:
            j = next((k for k, x in enumerate(fields) if x.get('label') == name), None)
            if j is not None: i = j + off; break
    fields.insert(i, f); return f

cur = call('GET', '/descriptors/' + ID)
if '--no-backup' in sys.argv: bk = {'descriptorId': 'skipped', 'status': '-'}
else:
    bk = call('POST', '/descriptors', {'screenName': cur['screenName'] + ' (backup before sheet R1)', 'deviceProfile': cur.get('deviceProfile'), 'vendor': cur.get('vendor'),
        'productFamily': cur.get('productFamily'), 'mibModule': cur.get('mibModule'), 'sections': cur['sections'], 'deviceUi': cur.get('deviceUi'),
        'selectedObjects': cur.get('selectedObjects', []), 'layoutMode': 'device'})
print('backup draft:', bk['descriptorId'][:8], bk['status'])
secs = copy.deepcopy(cur['sections'])
RADIO = {'Radio 1': 1, '5 GHz Radio': 1, 'Radio 2': 2, '2.4 GHz Radio': 0}
ROW = {1: '2', 2: '3', 0: '1'}   # wireless table row of each radio (Radio 1 = row 2 …)
radio_mode = {}                    # radio -> Radio Mode field of its Properties section (the VLAN Mode follows it)
def of(parent, tab): return [s for s in secs if s.get('uiPage') == 'Wireless' and s.get('uiParent') == parent and s.get('uiTab') == tab]

# ── Wireless ────────────────────────────────────────────────────────────────────────────────────────────
for parent, radio in (('Radio 1', 1), ('Radio 2', 2), ('2.4 GHz Radio', 0)):
    row = ROW[radio]
    for s in of(parent, 'Properties'):
        F = s['fields']; by = {f.get('mibObject'): f for f in F if f.get('mibObject')}
        if 'wirelessRadioMode' in by: radio_mode[radio] = by['wirelessRadioMode']
        def make_country():
            return {'fieldId': nid(), 'elementType': 'field-label', 'label': 'Country', 'mibObject': 'wirelessCountry', 'oid': f'{W}.1.1.4.{row}', 'access': 'read-only',
                    'uiHidden': True, 'order': 0, 'widget': 'text', 'valueSource': 'mib', 'labelSource': 'custom', 'labelLevel': 'field'}
        dependent_options.add(F, radio, make_country)
        by = {f.get('mibObject'): f for f in F if f.get('mibObject')}
        c = by.get('wirelessCountry')
        if c and radio:
            c['widget'] = 'Dropdown'
            c['enumMap'] = {'5011': 'US-Non DFS', '5012': 'US-5GHz ALL', '276': 'Europe', '124': 'Canada', '5019': '5 Ghz', '356': 'India'}
        bw = by.get('wirelessBandwidth')
        if bw: bw['enumMap'] = {k: k for k in (bw.get('enumMap') or {'HT20': 0, 'HT40+': 0})}
        ch = by.get('wirelessChannel')
        if ch: ch['widget'] = 'Dropdown'; ch['enumMap'] = {'auto': 'Auto'}
        for f in F:
            if f.get('label') == 'Key':
                f['widget'] = 'Text input'; f['helpText'] = '(8 – 63 ) Characters'; f['minValue'] = 8; f['maxValue'] = 63; f['access'] = 'read-write'
        if radio:   # 5 GHz radios only
            link, mode = by.get('wirelessLinktype'), by.get('wirelessRadioMode')
            if link and mode:
                put(F, fld('Maximum SUs', 'wirelessMaximumSUs', f'{W}.1.1.37.{row}', 'Text input', minValue=1, maxValue=32, helpText='(1-32)',
                           uiShowWhen=[{'field': mode['fieldId'], 'in': ['ap']}, {'field': link['fieldId'], 'in': ['3']}]), after='SSID')
            put(F, static('OFDMA', 'Disable(0)', helpText='Enable(1) / Disable(0) — default, no OID'), before='Distance')
        for i, f in enumerate(F): f['order'] = i
    for s in of(parent, 'DDRS/ATPC') if radio else []:
        F = s['fields']; L = {f['label']: f for f in F}
        ddrs, ss = L.get('DDRS Status'), L.get('Spatial Stream')
        if ddrs and ss:
            ss['optionsBy'] = {'dependsOn': [ddrs['fieldId']], 'table': {'1': '1:Single,2:Dual,3:Auto', '0': '1:Single,2:Dual'}}   # Auto only while DDRS is enabled
        for name in ('Min. Modulation Index', 'Max. Modulation Index', 'Modulation Index'):
            f = L.get(name)
            if f and ss:
                en = f.get('enumMap') or {}
                f['optionsBy'] = {'dependsOn': [ss['fieldId']], 'table': {'1': table_of(en, 0, 11), '2': table_of(en, 12, 23)}}   # single MCS0-11, dual MCS12-23
        for name, lo, hi in (('Max. Data Rate - Single Stream', 0, 11), ('Max. Data Rate - Dual Stream', 12, 23)):
            f = L.get(name)
            if f: f['enumMap'] = mcs(f.get('enumMap') or {}, lo, hi)
        tp = L.get('Transmit Power')
        if tp:   # Transmit Power is …2.1.12.<row>.1: ATPC Status is the same table's column 11
            put(F, fld('ATPC Status', 'linkProfileATPCStatus', f"{tp['oid'].rsplit('.', 3)[0]}.11.{row}.1", 'Dropdown', enumMap={'0': 'Disable', '1': 'Enable'}), before='Transmit Power')
        ag = L.get('Antenna Gain')
        put(F, static('Connectorized Antenna Gain', '23', helpText='(0-30) dBi — default, no OID'), after='Antenna Gain' if ag else None)
        for i, f in enumerate(F): f['order'] = i
    for s in of(parent, 'DCS') if radio else []:
        F = s['fields']; dm = next((f for f in F if f.get('label') == 'DCS Status'), None)
        if dm:
            rm = next((f for f in F if f.get('label') == 'Radio Mode'), None)
            put(F, fld('Background Scan', 'dcsBackgroundScan', f'{W}.3.1.11.{row}', 'Dropdown', enumMap={'0': 'Disable', '1': 'Enable'},
                       **({'uiShowWhen': [{'field': rm['fieldId'], 'in': ['ap']}]} if rm else {})), after='RTX Threshold')
        for i, f in enumerate(F): f['order'] = i

# ── Network: Ethernet (speed labels, MTU) ────────────────────────────────────────────────────────────────
for s in secs:
    if s.get('uiPage') == 'Network' and s.get('uiParent') == 'Ethernet' and s.get('uiTab') in ('LAN 1', 'LAN 2'):
        F = s['fields']; sp = next((f for f in F if f.get('label') == 'Speed / Duplex'), None)
        if not sp: continue
        e = sp.get('enumMap') or {}
        sp['enumMap'] = {k: ({'0': 'Auto', '4': '100-Full', '5': '1000-Full'}.get(k, v)) for k, v in e.items()}
        row = sp['oid'].rsplit('.', 1)[1]
        put(F, fld('MTU', 'ethMtu', f'.1.3.6.1.4.1.14125.123.1.1.5.6.1.4.{row}', 'Text input', minValue=1500, maxValue=9000, helpText='(1500-9000) Bytes'), after='Speed / Duplex')
        for i, f in enumerate(F): f['order'] = i
# the sheet gives MTU on Ethernet (.5.6.1.4) and Mgmt VLAN ID on VLAN (.4.18.1.11): they leave IP Configuration
for s in secs:
    if s.get('uiPage') == 'Network' and s.get('uiParent') == 'IP Configuration':
        s['fields'] = [f for f in s['fields'] if f.get('mibObject') not in ('ethernetMTU', 'vlanMgmtId')]
        for i, f in enumerate(s['fields']): f['order'] = i

# ── Network: VLAN per radio (device's vlan.athN page; sheet OIDs, row = radio) ──────────────────────────────
first = next((s for s in secs if s.get('uiPage') == 'Network' and s.get('uiParent') == 'VLAN' and s.get('uiTab') == 'VLAN'), None)
order0 = first['order'] if first else 20
secs = [s for s in secs if not (s.get('uiPage') == 'Network' and s.get('uiParent') == 'VLAN' and s.get('uiTab') in ('VLAN', 'Radio 1', 'Radio 2'))]
ETHER = {'0x0081': '0x8100', '0xa888': '0x88a8'}
for n in (1, 2):
    rm = radio_mode.get(n)
    if not rm: continue
    o = lambda col: f'{VT}.{col}.{n}'
    mode = fld('Mode', 'vlanTblMode', o(3), 'Dropdown', enumMap={'0': 'Transparent', '1': 'Access', '2': 'Trunk', '3': 'Q-in-Q'},
               optionsBy={'dependsOn': [rm['fieldId']], 'table': {'ap': '0:Transparent', 'sta': '0:Transparent,1:Access,2:Trunk,3:Q-in-Q'}})   # BTS: Transparent only
    opt = fld('Trunk Option', 'vlanTblTrunkOption', o(5), 'Dropdown', enumMap={'1': 'List', '2': 'ALL'}, uiShowWhen=[{'field': mode['fieldId'], 'in': ['2', '3']}])
    F = [
        fld('Mgmt VLAN ID', 'vlanTblMgmtId', o(11), 'Text input', minValue=1, maxValue=4094, helpText='(1-4094)'),
        mode,
        fld('Access VLAN ID', 'vlanTblAccessId', o(4), 'Text input', minValue=1, maxValue=4094, helpText='(1-4094)', uiShowWhen=[{'field': mode['fieldId'], 'in': ['1']}]),
        opt,
        fld('Trunk VLAN ID', 'vlanTblTrunkId', o(6), 'Text input', minValue=1, maxValue=4094, helpText='(1-4094, up to 100 entries)',
            idList={'deleteParam': 'vlanTblTrunkIdDelete', 'max': 100, 'minId': 1, 'maxId': 4094},
            uiShowWhen=[{'field': mode['fieldId'], 'in': ['2', '3']}, {'field': opt['fieldId'], 'in': ['1']}]),
        fld('Trunk VLAN ID Delete', 'vlanTblTrunkIdDelete', o(7), 'Text input', minValue=1, maxValue=4094, uiHidden=True),
        fld('SVLAN Priority', 'vlanTblSVlanPriority', o(14), 'Text input', minValue=0, maxValue=7, helpText='(0-7)', uiShowWhen=[{'field': mode['fieldId'], 'in': ['3']}]),
        fld('SVLAN ID', 'vlanTblSvlanId', o(8), 'Text input', minValue=1, maxValue=4094, helpText='(1-4094)', uiShowWhen=[{'field': mode['fieldId'], 'in': ['3']}]),
        fld('SVLAN EtherType', 'vlanTblSVlanEtherType', o(9), 'Dropdown', enumMap=dict(ETHER), uiShowWhen=[{'field': mode['fieldId'], 'in': ['3']}]),
        fld('CVLAN Priority', 'vlanTblCVlanPriority', o(16), 'Text input', minValue=0, maxValue=7, helpText='(0-7)', uiShowWhen=[{'field': mode['fieldId'], 'in': ['3']}]),
        fld('CVLAN ID', 'vlanTblCvlanId', o(17), 'Text input', minValue=1, maxValue=4094, helpText='(1-4094)', uiShowWhen=[{'field': mode['fieldId'], 'in': ['3']}]),
        fld('CVLAN EtherType', 'vlanTblCVlanEtherType', o(15), 'Dropdown', enumMap=dict(ETHER), uiShowWhen=[{'field': mode['fieldId'], 'in': ['3']}]),
    ]
    for i, f in enumerate(F): f['order'] = i
    secs.append({'sectionId': 's_' + uuid.uuid4().hex[:8], 'title': 'VLAN', 'columns': 2, 'fullWidth': False, 'pollInterval': 30, 'liveRefreshSeconds': 0,
                 'writeMode': 'apply-button', 'uiPage': 'Network', 'uiParent': 'VLAN', 'uiTab': f'Radio {n}', 'uiTitle': 'VLAN Configuration', 'uiLayout': 'form',
                 'uiHideWhenEmpty': n == 2, 'order': order0 + n, 'fields': F})
d = call('PUT', '/descriptors/' + ID, {'sections': secs, 'layoutMode': 'device'})
print('saved:', len(d['sections']), 'sections')
p = call('POST', '/descriptors/' + ID + '/publish', {})
print('published:', p['status'], p.get('layoutMode'))
