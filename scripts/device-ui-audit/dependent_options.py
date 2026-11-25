"""Dependent dropdowns for the Wireless > Properties tab, mirroring the device page's own chain:

    Link Type -> Radio Mode -> Country -> Bandwidth -> Configured Channel

Read from the device web UI (wireless pages' script + GET /admin/wireless/{coun_list,band_list,chan_list}, read only):
  - Radio Mode options: AP/STA for Link Type 0 (the 2.4 GHz radio), BTS/CPE for PTP (1) / PTMP (3)
  - Bandwidth list = band_list/<country>/<radio>
  - Channel list   = chan_list/<radio>/<country>/<bandwidth>;  changing the bandwidth resets the channel to Auto
Country itself is not shown by the device page (hidden), so it stays a hidden helper field that feeds the lists.
radio_options.json holds the crawled lists (country codes 356 India, 5019 5GHz, 840 US 2.4GHz).  A country/bandwidth that
has no entry falls back to the device's own supported list (optionsFrom), so an unknown country never shows an empty dropdown.
"""
import json, os, re

OPTS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'radio_options.json')))
DEFAULT_COUNTRY = {0: '840', 1: '356', 2: '356'}   # 2.4 GHz radio only has US 2.4GHz (840)
MODE_BY_LINKTYPE = {'0': 'ap:AP,sta:STA', '1': 'ap:BTS,sta:CPE', '3': 'ap:BTS,sta:CPE'}


def _hlabel(bands):
    """'HT20:20 MHz,HT40+:40 MHz' -> 'HT20:HT20,HT40+:HT40+' — the Configurations sheet lists Bandwidth as HT20(HT20), HT40+(HT40+) …"""
    return re.sub(r'(HT\d+\+?):[^,]+', r'\1:\1', bands)


def add(fields, radio, make_country):
    """fields: the field dicts of one radio's Properties section; radio: 0 (2.4 GHz), 1 or 2.
    make_country(): a new hidden Country field (wirelessCountry, this radio's row). Returns True when something was added."""
    by = {f.get('mibObject'): f for f in fields if f.get('mibObject')}
    bw, ch = by.get('wirelessBandwidth'), by.get('wirelessChannel')
    mode, link = by.get('wirelessRadioMode'), by.get('wirelessLinktype')
    if not bw or not ch:
        return False
    tables = OPTS[str(radio)]
    country = by.get('wirelessCountry')
    if not country:
        country = make_country()
        fields.insert(fields.index(link or mode or bw), country)
    if link and mode:
        mode['optionsBy'] = {'dependsOn': [link['fieldId']], 'table': dict(MODE_BY_LINKTYPE)}
    dflt = DEFAULT_COUNTRY[radio]          # Country is hidden: the device's value is used, India (356) while it has none
    bw['optionsBy'] = {'dependsOn': [country['fieldId']], 'defaults': {country['fieldId']: dflt}, 'table': {c: _hlabel(t['bands']) for c, t in tables.items()}}
    ch['optionsBy'] = {'dependsOn': [country['fieldId'], bw['fieldId']], 'defaults': {country['fieldId']: dflt}, 'resetOnChange': True, 'resetTo': 'auto',
                       'table': {f'{c}|{b}': lst for c, t in tables.items() for b, lst in t['chan'].items()}}
    return True
