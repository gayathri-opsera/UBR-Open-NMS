"""Usage: python3 apply_graphs.py <descriptorId> [--no-backup]   (a UBR655 screen)

Item 4 — Monitor > <radio> Statistics > Graphs, from the Monitor rows of Configurations_GUI_R1.xlsx (rows 58-79):
  * the sheet's Monitor rows the tables lacked are added: Interface: Tx/Rx Broadcast Packets, CRC / Frame Errors;
    Link: Radio Index, IP Address, Uptime, CustomerName
  * a 'Graphs' tab per radio (Radio 1 = statistics row 2, Radio 2 = row 3) with the charts below. The NMS collector stores their
    values (every 5 min; hourly averages kept 6 months) and each chart has its own range: 1 Hour / 1 Day / 1 Week / 1 Month / 3 / 6 Months / Custom.
      Throughput (Tx, Rx · Mbps)       Total / Unicast / Multicast / Broadcast packets per second (Tx, Rx — counters stored as rates)
      Errors per second (CRC, Frame)   RTX %      Link SNR (Local / Remote A1, A2, one line per link · dB)
Backs the screen up first, saves, republishes; idempotent.  Reads nothing from, and sends nothing to, a device.  Needs login.json."""
import json, sys, copy, uuid, urllib.request
T = json.load(open('login.json'))['data']['accessToken']
ID = next(a for a in sys.argv[1:] if not a.startswith('--'))
def call(m, u, b=None):
    r = urllib.request.Request('http://localhost:5173/api/v1/ui-builder' + u, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r, timeout=90))['data']
nid = lambda: 'f_' + uuid.uuid4().hex[:8]
IF = '.1.3.6.1.4.1.14125.123.1.3.1.1'   # wireless statistics table (row = radio: 1 = 2.4 GHz, 2 = Radio 1, 3 = Radio 2)
LK = '.1.3.6.1.4.1.14125.123.1.3.3.1'   # link statistics table (index radio.link)
def col(label, mib, oid):
    return {'fieldId': nid(), 'elementType': 'table-block', 'label': label, 'labelLevel': 'field', 'mibObject': mib, 'oid': oid, 'syntax': 'STRING',
            'access': 'read-only', 'widget': 'Data table', 'pollInterval': 30, 'confirmWrite': False}
def put(fields, f, after=None):
    cur = next((x for x in fields if x.get('mibObject') == f['mibObject']), None)
    if cur: return cur
    i = len(fields)
    if after:
        j = next((k for k, x in enumerate(fields) if x.get('mibObject') == after), None)
        if j is not None: i = j + 1
    fields.insert(i, f); return f

# the fields the charts read (parameter name -> OID) — all of them sheet rows
CH_FIELDS = [
    ('Tx Throughput', 'wirelessStatsTxThroughput', IF + '.30'), ('Rx Throughput', 'wirelessStatsRxThroughput', IF + '.31'),
    ('Tx Total Packets', 'wirelessStatsDataTxTotalPackets', IF + '.4'), ('Rx Total Packets', 'wirelessStatsDataRxTotalPackets', IF + '.5'),
    ('Tx Unicast Packets', 'wirelessStatsDataTxUnicastPackets', IF + '.8'), ('Rx Unicast Packets', 'wirelessStatsDataRxUnicastPackets', IF + '.9'),
    ('Tx Multicast Packets', 'wirelessStatsDataTxMulticastPackets', IF + '.6'), ('Rx Multicast Packets', 'wirelessStatsDataRxMulticastPackets', IF + '.7'),
    ('Tx Broadcast Packets', 'wirelessStatsDataTxBroadcastPackets', IF + '.32'), ('Rx Broadcast Packets', 'wirelessStatsDataRxBroadcastPackets', IF + '.33'),
    ('CRC Errors', 'wirelessStatsCRCErrors', IF + '.28'), ('Frame Errors', 'wirelessStatsFrameErrors', IF + '.29'),
    ('RTX Percent', 'wirelessStatsRTXPercent', IF + '.37'),
    ('Local SNR A1', 'assocLocalSNRA1', LK + '.13'), ('Local SNR A2', 'assocLocalSNRA2', LK + '.14'),
    ('Remote SNR A1', 'assocRemoteSNRA1', LK + '.15'), ('Remote SNR A2', 'assocRemoteSNRA2', LK + '.16'),
]
def pair(p, label_tx='Tx', label_rx='Rx', rate=True):
    return [{'param': f'wirelessStatsData{"Tx" if i == 0 else "Rx"}{p}Packets', 'label': (label_tx, label_rx)[i], **({'rate': True} if rate else {})} for i in (0, 1)]
CHARTS = [
    {'id': 'throughput', 'title': 'Throughput', 'unit': 'Mbps', 'decimals': 2,
     'series': [{'param': 'wirelessStatsTxThroughput', 'label': 'Tx'}, {'param': 'wirelessStatsRxThroughput', 'label': 'Rx'}]},
    {'id': 'packets', 'title': 'Total packets', 'unit': 'pkt/s', 'decimals': 0, 'series': pair('Total')},
    {'id': 'unicast', 'title': 'Unicast packets', 'unit': 'pkt/s', 'decimals': 0, 'series': pair('Unicast')},
    {'id': 'multicast', 'title': 'Multicast packets', 'unit': 'pkt/s', 'decimals': 1, 'series': pair('Multicast')},
    {'id': 'broadcast', 'title': 'Broadcast packets', 'unit': 'pkt/s', 'decimals': 1, 'series': pair('Broadcast')},
    {'id': 'errors', 'title': 'Errors', 'unit': 'err/s', 'decimals': 2,
     'series': [{'param': 'wirelessStatsCRCErrors', 'label': 'CRC errors', 'rate': True}, {'param': 'wirelessStatsFrameErrors', 'label': 'Frame errors', 'rate': True}]},
    {'id': 'rtx', 'title': 'RTX', 'unit': '%', 'decimals': 0, 'series': [{'param': 'wirelessStatsRTXPercent', 'label': 'RTX %'}]},
    {'id': 'snr', 'title': 'Link SNR', 'unit': 'dB', 'decimals': 0,
     'series': [{'param': p, 'label': l, 'perLink': True} for p, l in (('assocLocalSNRA1', 'Local A1'), ('assocLocalSNRA2', 'Local A2'), ('assocRemoteSNRA1', 'Remote A1'), ('assocRemoteSNRA2', 'Remote A2'))]},
]

cur = call('GET', '/descriptors/' + ID)
if '--no-backup' in sys.argv: bk = {'descriptorId': 'skipped', 'status': '-'}
else:
    bk = call('POST', '/descriptors', {'screenName': cur['screenName'] + ' (backup before graphs)', 'deviceProfile': cur.get('deviceProfile'), 'vendor': cur.get('vendor'),
        'productFamily': cur.get('productFamily'), 'mibModule': cur.get('mibModule'), 'sections': cur['sections'], 'deviceUi': cur.get('deviceUi'),
        'selectedObjects': cur.get('selectedObjects', []), 'layoutMode': 'device'})
print('backup draft:', bk['descriptorId'][:8], bk['status'])
secs = copy.deepcopy(cur['sections'])

# 1) the sheet's Monitor rows the tables lacked
for s in secs:
    if s.get('uiPage') != 'Monitor' or s.get('uiParent') != 'Radio 1 Statistics': continue
    F = s['fields']
    if s.get('uiTab') == 'Interface':
        put(F, col('TxBroadcastPackets', 'wirelessStatsDataTxBroadcastPackets', IF + '.32'), after='wirelessStatsDataRxUnicastPackets')
        put(F, col('RxBroadcastPackets', 'wirelessStatsDataRxBroadcastPackets', IF + '.33'), after='wirelessStatsDataTxBroadcastPackets')
        put(F, col('CRCErrors', 'wirelessStatsCRCErrors', IF + '.28'), after='wirelessStatsRxThroughput')
        put(F, col('FrameErrors', 'wirelessStatsFrameErrors', IF + '.29'), after='wirelessStatsCRCErrors')
    if s.get('uiTab') == 'Link':
        put(F, col('Radio Index', 'assocRadioIndex', LK + '.1'))
        F.insert(0, F.pop(next(i for i, x in enumerate(F) if x.get('mibObject') == 'assocRadioIndex')))
        put(F, col('IP Address', 'assocIP', LK + '.4'), after='assocMAC')
        put(F, col('Uptime', 'assocLinkUptime', LK + '.52'), after='assocIP')
        put(F, col('CustomerName', 'assocRemoteCustomername', LK + '.29'), after='assocLinkUptime')
    for i, f in enumerate(F): f['order'] = i

# 2) a Graphs tab per radio
secs = [s for s in secs if not (s.get('uiPage') == 'Monitor' and s.get('uiTab') == 'Graphs')]
order0 = max([s.get('order', 0) for s in secs] + [0]) + 1
for n, (parent, row) in enumerate((('Radio 1 Statistics', '2'), ('Radio 2 Statistics', '3'))):
    F = [col(l, m, o) for l, m, o in CH_FIELDS]
    for i, f in enumerate(F): f['order'] = i
    secs.append({'sectionId': 's_' + uuid.uuid4().hex[:8], 'title': 'Graphs', 'columns': 2, 'fullWidth': True, 'pollInterval': 300, 'liveRefreshSeconds': 300,   # live: the history collector reads this group (GET-only Monitor read)
                 
                 'writeMode': 'read-only', 'uiPage': 'Monitor', 'uiParent': parent, 'uiTab': 'Graphs', 'uiTitle': parent, 'uiLayout': 'charts',
                 'uiCharts': {'row': row, 'charts': copy.deepcopy(CHARTS)}, 'order': order0 + n, 'fields': F})
d = call('PUT', '/descriptors/' + ID, {'sections': secs, 'layoutMode': 'device'})
print('saved:', len(d['sections']), 'sections')
p = call('POST', '/descriptors/' + ID + '/publish', {})
print('published:', p['status'], p.get('layoutMode'))
