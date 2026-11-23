"""UBR655 additions to the UBR default screen: Radio 2, every Radio tab (Properties, DDRS/ATPC, DCS, DFS, Shaping) and the rows the
device UI shows only in some modes. Built from a crawl of the reference device 10.0.150.112 (a CPE) plus a BTS-mode unit
(10.0.150.107) so that rows the page hides for the other mode are known too.

Needs web_parsed.json (the crawl, see build_web_parsed.py) next to mib_objects.json.  Imports spec.py for the field helpers.

Mode rules (read from the device pages' own script, not guessed):
  - Properties: Bandwidth / Configured Channel / Intra Cell Blocking / DL-UL Ratio are shown for a BTS radio only
  - DDRS/ATPC : Modulation Index when DDRS is off and Spatial Stream is not Auto; Min/Max Modulation Index when DDRS is on and
                Spatial Stream is not Auto; Max Data Rate (single / dual) when DDRS is on and Spatial Stream is Auto
  - DCS tab   : BTS radio only      DFS tab: CPE radio only
Fields with no SNMP object on the device (Bridge, OFDMA, Scheduler host/offload, Beacon / Scan Interval, Force Bandwidth,
the DCS dwell timers) cannot be shown from SNMP and are left out.
"""
import re
import spec
import dependent_options
from spec import mib, tpl, static, section, NOTE_W, web_enum

WEB = spec.WEB


def opts(page, label, name_has=None, occ=0):
    """raw -> label from the device page's <select> ("Label(value)"); name_has picks the control when a label occurs twice."""
    fs = [x for x in WEB[page]['fields'] if x['label'] == label and (name_has is None or name_has in (x.get('name') or ''))]
    out = {}
    for o in (fs[occ].get('options') or []):
        m = re.match(r'^(.*)\(([^()]*)\)$', o)
        if m:
            out[m.group(2)] = m.group(1)
    return out


def hidden(label, obj, row):
    f = mib(label, obj, row, ro=True)
    f['uiHidden'] = True
    return f


def when(f, *conds):
    """conds: (sibling_field, 'in'|'notIn', [raw, …])"""
    f['uiShowWhen'] = [{'field': c[0]['fieldId'], c[1]: list(c[2])} for c in conds]
    return f


def gate(fields, mode):
    """A radio the unit does not have (a UBR660 has no Radio 2) still answers some table rows with defaults, but never a Radio Mode:
    every row of such a radio waits for a known mode, so the whole radio disappears once it has been read."""
    for f in fields:
        if f is mode or f.get('valueSource') == 'static' or f.get('uiHidden'):
            continue
        f['uiShowWhen'] = (f.get('uiShowWhen') or []) + [{'field': mode['fieldId'], 'in': ['ap', 'sta'], 'required': True}]
    mode['uiHideWhenEmpty'] = True
    return fields


def _gate_hidden_mode(fields, mode):
    """gate() for a section whose mode field is a hidden helper (it must not get hide-when-empty itself)."""
    gate(fields, mode)
    mode.pop('uiHideWhenEmpty', None)
    return fields


def blank(label):
    """A row the device page shows but its SNMP agent has no object for: kept in the layout, empty (type a value into it in the builder if wanted)."""
    return static(label, '')


def radio_sections(n, parent, hide_when_empty, ghz6=False):
    """Sections of 'Radio n' (n = 1, 2): table row r = n + 1, link profile r.1; web pages wireless_radioN[_ddrsN|_dcsN|_dfsN|_shapingN]."""
    r = n + 1
    lp = f'{r}.1'
    P = f'wireless_radio{n}'
    S = []

    mode = mib('Radio Mode', 'wirelessRadioMode', r, enum={'ap': 'BTS', 'sta': 'CPE'})
    supp_bw = hidden('Supported Bandwidths', 'wirelessSupportedBandwidths', r)
    supp_ch = hidden('Supported Channels', 'wirelessSupportedChannels', r)
    bw = mib('Bandwidth', 'wirelessBandwidth', r, enum=opts(P, 'Bandwidth', 'htmode'))
    bw['optionsFrom'] = supp_bw['fieldId']
    ch = mib('Configured Channel', 'wirelessChannel', r, enum={'auto': 'Auto'})
    ch['optionsFrom'] = supp_ch['fieldId']
    props = [
        mib('Status', 'wirelessRadioStatus', r, enum=opts(P, 'Status')),
        blank('Bridge'),
        mib('Link Type', 'wirelessLinktype', r, enum=opts(P, 'Link Type')),
        mode,
        mib('SSID', 'wirelessSSID', r),
        when(bw, (mode, 'in', ['ap'])),
        when(blank('Bandwidth'), (mode, 'in', ['sta'])),            # the CPE page's own "Bandwidth" row (Force Bandwidth)
        *([blank('Enable 6GHz')] if ghz6 else []),
        when(ch, (mode, 'in', ['ap'])),
        supp_bw, supp_ch,
        tpl('Active Channel', '{c} ( {f} MHz )', [('c', 'wirelessActiveChannel', r), ('f', 'wirelessActiveFrequency', r)]),
        mib('Encryption', 'wirelessSecurityEncryption', r, enum=opts(P, 'Encryption')),
        static('Key'), static('Network Secret'),
        blank('OFDMA'),
        mib('Distance', 'wirelessDistance', r),
        when(mib('Intra Cell Blocking', 'wirelessIntracellBlocking', r, enum=opts(P, 'Intra Cell Blocking')), (mode, 'in', ['ap'])),
        blank('Scheduler'),
        when(blank('Beacon Interval'), (mode, 'in', ['ap'])),
        when(blank('Scan Interval'), (mode, 'in', ['sta'])),
        when(mib('DL/UL Ratio', 'wirelessDlUlRatio', r, enum=opts(P, 'DL/UL Ratio')), (mode, 'in', ['ap'])),
    ]
    dependent_options.add(props, n, lambda: hidden('Country', 'wirelessCountry', r))   # Link Type -> Radio Mode -> Country -> Bandwidth -> Channel
    S.append(section('Wireless', parent, 'Properties', 'Properties', gate(props, mode) if n == 2 else props,
                     layout='form', heading=f'Radio {n} Configuration', note=NOTE_W, hide=hide_when_empty))

    # ---- DDRS / ATPC ----
    PD = f'wireless_radio{n}_ddrs{n}'
    mcs = {}
    for lab in ('Modulation Index', 'Min. Modulation Index', 'Max. Modulation Index', 'Max. Data Rate - Single Stream', 'Max. Data Rate - Dual Stream'):
        mcs.update(opts(PD, lab))
    ddrs = mib('DDRS Status', 'linkProfileDDRSStatus', lp, enum=opts(PD, 'DDRS Status'))
    stream = mib('Spatial Stream', 'linkProfileSpatialStream', lp, enum=opts(PD, 'Spatial Stream') or {'1': 'Single', '2': 'Dual', '3': 'Auto', '4': 'Triple', '5': 'Quad'})
    country = hidden('Country', 'wirelessCountry', r)
    gmode = hidden('Radio Mode', 'wirelessRadioMode', r)
    ddrs_rows = [
        gmode, ddrs, stream,
        when(mib('Modulation Index', 'linkProfileTxRate', lp, enum=mcs), (ddrs, 'notIn', ['1']), (stream, 'notIn', ['3'])),
        when(mib('Min. Modulation Index', 'linkProfileDDRSMinRate', lp, enum=mcs), (ddrs, 'in', ['1']), (stream, 'notIn', ['3'])),
        when(mib('Max. Modulation Index', 'linkProfileDDRSMaxRate', lp, enum=mcs), (ddrs, 'in', ['1']), (stream, 'notIn', ['3'])),
        when(mib('Max. Data Rate - Single Stream', 'linkProfileDDRSMaxSingleRate', lp, enum=mcs), (ddrs, 'in', ['1']), (stream, 'in', ['3'])),
        when(mib('Max. Data Rate - Dual Stream', 'linkProfileDDRSMaxDualRate', lp, enum=mcs), (ddrs, 'in', ['1']), (stream, 'in', ['3'])),
        mib('Transmit Power', 'linkProfilePower', lp),
        country,
        when(mib('Maximum EIRP', 'wirelessMaximumEIRP', r), (country, 'notIn', ['356'])),
        mib('Antenna Gain', 'wirelessAntennaGain', r, units='dBi'),
    ]
    S.append(section('Wireless', parent, 'DDRS/ATPC', 'DDRS/ATPC', _gate_hidden_mode(ddrs_rows, gmode) if n == 2 else ddrs_rows,
                     layout='form', heading=f'Radio {n} Configuration', hide=hide_when_empty))

    # ---- DCS (BTS radio only) ----
    PC = f'wireless_radio{n}_dcs{n}'
    dmode = hidden('Radio Mode', 'wirelessRadioMode', r)
    dcs_rows = [
        dmode,
        when(mib('DCS Status', 'dcsStatus', r, enum=opts(PC, 'DCS Status')), (dmode, 'in', ['ap'])),
        when(mib('RTX Threshold', 'dcsThreshold', r), (dmode, 'in', ['ap'])),
        *[when(blank(l), (dmode, 'in', ['ap'])) for l in ('Max Dwell Time', 'Splits per Channel', 'Dwell Rest Time', 'Scan Iteration Interval', 'Scan Rest time', 'Passive Dwell')],
    ]
    if n == 2:   # a radio the unit does not have has no mode: its rows wait for one
        for f in dcs_rows[1:]:
            f['uiShowWhen'][0]['required'] = True
    S.append(section('Wireless', parent, 'DCS', 'DCS', dcs_rows, layout='form', heading=f'Radio {n} Configuration', hide=True))

    # ---- DFS (CPE radio only) ----
    PF = f'wireless_radio{n}_dfs{n}'
    fmode = hidden('Radio Mode', 'wirelessRadioMode', r)
    dfs_rows = [
        fmode,
        when(mib('Status', 'wirelessDFSStatus', r, enum=opts(PF, 'Status')), (fmode, 'in', ['sta'])),
    ]
    if n == 2:
        dfs_rows[1]['uiShowWhen'][0]['required'] = True
    S.append(section('Wireless', parent, 'DFS', 'DFS', dfs_rows, layout='form', heading=f'Radio {n} Configuration', hide=True))

    # ---- Shaping ----
    PS = f'wireless_radio{n}_shaping{n}'
    smode = hidden('Radio Mode', 'wirelessRadioMode', r)
    shaping_rows = [
        smode,
        mib('Traffic Shaping', 'wirelessTrafficShaping', r, enum=opts(PS, 'Traffic Shaping')),
        mib('Incoming Traffic Limit', 'wirelessDownlinkLimit', r),
        mib('Outgoing Traffic Limit', 'wirelessUplinkLimit', r),
    ]
    S.append(section('Wireless', parent, 'Shaping', 'Shaping', _gate_hidden_mode(shaping_rows, smode) if n == 2 else shaping_rows,
                     layout='form', heading=f'Radio {n} Configuration', hide=hide_when_empty))
    return S


def radio24_section():
    P = 'wireless_radio0'
    supp_bw = hidden('Supported Bandwidths', 'wirelessSupportedBandwidths', 1)
    supp_ch = hidden('Supported Channels', 'wirelessSupportedChannels', 1)
    bw = mib('Bandwidth', 'wirelessBandwidth', 1, enum=opts(P, 'Bandwidth', 'htmode'))
    bw['optionsFrom'] = supp_bw['fieldId']
    ch = mib('Configured Channel', 'wirelessChannel', 1, enum={'auto': 'Auto'})
    ch['optionsFrom'] = supp_ch['fieldId']
    rows = [
        mib('Status', 'wirelessRadioStatus', 1, enum=opts(P, 'Status')),
        blank('Bridge'),
        tpl('Radio Mode', '{m}', [('m', 'wirelessRadioMode', 1, {'map': {'ap': 'AP', 'sta': 'STA'}})]),
        mib('SSID', 'wirelessSSID', 1),
        bw, ch, supp_bw, supp_ch,
        tpl('Active Channel', '{c} ( {f} MHz )', [('c', 'wirelessActiveChannel', 1), ('f', 'wirelessActiveFrequency', 1)]),
        mib('Encryption', 'wirelessSecurityEncryption', 1, enum=opts(P, 'Encryption')),
        static('Key'),
        blank('Scheduler'),
    ]
    dependent_options.add(rows, 0, lambda: hidden('Country', 'wirelessCountry', 1))
    return section('Wireless', '2.4 GHz Radio', 'Properties', 'Properties', rows, layout='form', heading='2.4 GHz Configuration', note=NOTE_W)


def wireless_sections(model='655'):
    """All 'Wireless' sections in device order. 655: Radio 1 (5 GHz), Radio 2 (6 GHz, hidden when the unit has no second radio), 2.4 GHz.
    660: Radio 1 (6 GHz) and 2.4 GHz only."""
    if model == '660':
        return radio_sections(1, 'Radio 1', False, ghz6=True) + [radio24_section()]
    return radio_sections(1, 'Radio 1', False) + radio_sections(2, 'Radio 2', True, ghz6=True) + [radio24_section()]


def radio2_header(first):
    """Header badge for Radio 2, same sources as Radio 1 one row further down the radio table."""
    return {
        'label': 'Radio 2', 'mode': 'BTS', 'up': True,
        'modeSource': {'kind': 'template', 'template': '{mode}', 'inputs': [{'name': 'mode', 'oid': '.1.3.6.1.4.1.14125.123.1.1.1.1.1.2.3', 'sample': 'ap', 'map': {'ap': 'BTS', 'sta': 'CPE'}}]},
        'upSource': {'oid': '.1.3.6.1.4.1.14125.123.1.1.1.1.1.33.3', 'upValues': ['0'], 'sample': '0'},
    }
