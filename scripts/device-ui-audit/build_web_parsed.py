"""Merge crawl output(s) into web_parsed.json, the page data spec.py / spec_ubr655.py read.
usage: python3 build_web_parsed.py <reference_crawl.json> [<other_mode_crawl.json> …]
The first file is the reference device; later files only ADD rows / options the reference page did not show (a CPE page hides
BTS rows and vice versa).  Page keys: 'wireless/radio1/ddrs1' -> 'wireless_radio1_ddrs1'.  Not committed (holds device settings)."""
import json, sys
out = {}
for n, path in enumerate(sys.argv[1:]):
    for page, d in json.load(open(path)).items():
        if 'fields' not in d:
            continue
        key = page.replace('/', '_')
        cur = out.setdefault(key, {'title': d.get('title'), 'fields': [], 'tables': d.get('tables', []), 'cards': d.get('cards', [])})
        have = {(f['label'], f.get('name')): f for f in cur['fields']}
        for f in d['fields']:
            k = (f['label'], f.get('name'))
            if k not in have:
                cur['fields'].append(f); have[k] = f
            elif f.get('options') and not have[k].get('options'):
                have[k]['options'] = f['options']
json.dump(out, open('web_parsed.json', 'w'), indent=1)
print(len(out), 'pages ->', 'web_parsed.json')
