"""Mapping of the UBR660 web UI (every page/tab) to MIB objects, and how each value is rendered.
Each field: web=(page, label, occurrence) is the web-UI field it mirrors (used by the verification)."""
import json,re,uuid
OBJS={o['name']:o for o in json.load(open('mib_objects.json'))}
WEB=json.load(open('web_parsed.json'  # produced by crawl.mjs (not committed: it holds device settings)))
SECRET='********'
def _id(): return 'f_'+uuid.uuid4().hex[:8]
def oid(name,row=None):
    b=OBJS[name]['oid']; return b if row is None else f'{b}.{row}'
def web_enum(page,label,occ=0,fix=None):
    """raw -> label from the web UI's own <select> options ("Label(value)")."""
    f=[x for x in WEB[page]['fields'] if x['label']==label][occ]
    out={}
    for o in f.get('options') or []:
        m=re.match(r'^(.*)\(([^()]*)\)$',o)
        if m: out[m.group(2)]=fix(m.group(1)) if fix else m.group(1)
    return out
HINT={'SSID':'(1-32) characters','Key':'(8-63) characters'}

def mib(label,obj,row=None,*,web=None,enum=None,ro=False,widget=None,units=None,hint=None,empty=None,el='field-label',label_from=None):
    o=OBJS[obj]; rw=('write' in (o.get('access') or '')) and not ro
    f={'fieldId':_id(),'elementType':el,'label':label,'labelLevel':'field','mibObject':obj,'oid':oid(obj,row),'syntax':o.get('nmsDataType'),
       'access':'read-write' if rw else 'read-only','pollInterval':30,'order':0}
    if enum: f['enumMap']=enum
    f['widget']=widget or ('Dropdown' if (enum and rw) else 'Status badge' if enum else 'Text input' if rw else 'Text value')
    if el=='table-block': f['widget']='Data table'; f['access']='read-only'
    if units: f['units']=units
    if hint or label in HINT and rw: f['helpText']=hint or HINT.get(label)
    if empty is not None: f['emptyValues']=empty
    if web: f['_web']=web
    return f
def tpl(label,template,inputs,*,fallback=None,web=None):
    ins=[]
    for i in inputs:
        n,obj,row=i[0],i[1],i[2]; d={'name':n,'oid':oid(obj,row)}
        if len(i)>3 and i[3]: d.update(i[3])
        ins.append(d)
    f={'fieldId':_id(),'elementType':'field-label','label':label,'labelLevel':'field','valueSource':'calc','widget':'Text value','access':'read-only','pollInterval':30,'order':0,
       'calc':{'expr':'','template':template,'fallback':fallback,'inputs':ins}}
    if web: f['_web']=web
    return f
def static(label,text=SECRET,*,web=None):
    f={'fieldId':_id(),'elementType':'field-label','label':label,'labelLevel':'field','valueSource':'static','staticValue':text,'widget':'Text value','access':'read-only','pollInterval':30,'order':0}
    if web: f['_web']=web
    return f

def section(page,parent,tab,title,fields,*,layout=None,column=None,note=None,heading=None,matrix=None,hide=False):
    for i,f in enumerate(fields): f['order']=i
    rw=any(f.get('access')=='read-write' for f in fields)
    s={'sectionId':'s_'+uuid.uuid4().hex[:8],'title':title,'columns':2,'fullWidth':False,'pollInterval':30,'liveRefreshSeconds':0,'writeMode':'apply-button' if rw else 'read-only',
       'uiPage':page,'uiParent':parent,'uiTab':tab,'fields':fields}
    if heading: s['uiTitle']=heading
    if note: s['uiNote']=note
    if layout: s['uiLayout']=layout
    if column: s['uiColumn']=column
    if matrix: s['uiMatrix']=matrix
    if hide: s['uiHideWhenEmpty']=True
    return s

NOTE_W="Note:\n1. Special characters (single/double quotes and space) are not allowed for configuration.\n2. Change in Bandwidth reset the Configured channel to default."
def compact(s): return re.sub(r'\(\s*(\d+) MHz \)',r'(\1 MHz)',s)

def build_sections():
    S=[]
    # ============ Summary (Quick Start) ============
    chan_r1=web_enum('wireless_radio1','Configured Channel'); chan_r0=web_enum('wireless_radio0','Configured Channel')
    chan_compact={k:compact(v) for k,v in {**chan_r0,**chan_r1}.items()}
    PG='home'
    S.append(section('Quick Start','Quick Start','Summary','System',[
        mib('Model','sysInventoryModelName',ro=True,web=(PG,'Model')),
        mib('Hardware Version','sysInventoryHardwareVersion',ro=True,web=(PG,'Hardware Version')),
        mib('Bootloader Version','sysInventoryBootloaderVersion',ro=True,web=(PG,'Bootloader Version')),
        tpl('Local Time','{t}',[('t','ntpLocalTime',None,{'strip':' [A-Z]{2,4}(?= \\d{4}$)'})],web=(PG,'Local Time')),
        mib('Temperature','sysInfoTemperature',ro=True,units='°C',web=(PG,'Temperature')),
        tpl('GPS','{lat} {lon}',[('lat','sysInfoGeolat',None),('lon','sysInfoGeolong',None)],fallback='- -',web=(PG,'GPS')),
        mib('Elevation','sysInfoGeoAltitude',ro=True,web=(PG,'Elevation')),
        tpl('CPU / Memory','( {cpu} / {mem} ) %',[('cpu','sysInfoCPUUsage',None),('mem','sysInfoMemoryUsage',None)],web=(PG,'CPU / Memory')),
    ],layout='card',column='left',heading='Summary'))
    S.append(section('Quick Start','Quick Start','Summary','Network',[
        mib('IP Address','networkIPAddress',ro=True,web=(PG,'IP Address')),
        mib('Gateway','networkGateway',ro=True,web=(PG,'Gateway')),
        mib('VLAN Status','vlanStatus',ro=True,enum={'0':'Disabled','1':'Enabled'},web=(PG,'VLAN Status')),
    ],layout='card',column='left',heading='Summary'))
    for n,row in (('LAN 1',1),('LAN 2',2)):
        S.append(section('Quick Start','Quick Start','Summary',n,[
            mib('MAC Address','ethernetMACAddress',row,ro=True,web=(PG,'MAC Address',row-1)),
            tpl('Speed / Duplex','<<st=Up|Up {sp} - {du}|Down>>',[('st','ethernetStatus',row),('sp','ethernetSpeed',row),('du','ethernetDuplex',row)],web=(PG,'Speed / Duplex',row-1)),
            mib('Cable Length','ethCableLength',row,ro=True,web=(PG,'Cable Length',row-1)),
        ],layout='card',column='left',heading='Summary'))
    cols=lambda: [{'index':'2','label':'Radio 1','map':{'ap':'BTS','sta':'CPE'}},{'index':'3','label':'Radio 2','map':{'ap':'BTS','sta':'CPE'}},{'index':'1','label':'2.4 GHz','map':{'ap':'AP','sta':'STA'}}]
    S.append(section('Quick Start','Quick Start','Summary','Performance ( Mbps )',[
        mib('Tx','wirelessStatsTxThroughput',el='table-block',web=(PG,'Tx')),
        mib('Rx','wirelessStatsRxThroughput',el='table-block',web=(PG,'Rx')),
    ],layout='matrix',column='right',heading='Summary',matrix={'hideEmptyColumns':False,'columns':cols()}))
    S.append(section('Quick Start','Quick Start','Summary','LAN Performance ( Mbps )',[
        mib('Tx','ethernetTxThroughput',el='table-block'),mib('Rx','ethernetRxThroughput',el='table-block'),
    ],layout='matrix',column='right',heading='Summary',matrix={'hideEmptyColumns':False,'columns':[{'index':'1','label':'LAN 1'},{'index':'2','label':'LAN 2'}]}))
    S.append(section('Quick Start','Quick Start','Summary','Wireless',[
        mib('Radio Status','wirelessRadioStatus',el='table-block',enum={'0':'Enabled','1':'Disabled','-1':'Disabled'}),
        mib('MAC Address','wirelessStatsAthMACAddress',el='table-block'),
        mib('Link Type','wirelessLinktype',el='table-block',enum={'0':'WI-FI','1':'PTP','3':'PTMP'}),
        mib('Radio Mode','wirelessRadioMode',el='table-block'),
        mib('Bandwidth','wirelessBandwidth',el='table-block',enum={k:v for k,v in web_enum('wireless_radio1','Bandwidth').items()}),
        mib('SSID','wirelessSSID',el='table-block'),
        mib('Configured Channel','wirelessChannel',el='table-block',enum=chan_compact),
        mib('Active Channel','wirelessActiveChannel',el='table-block',enum=chan_compact,empty=['0','-1','-NA-','NA','-']),
        mib('Security','wirelessSecurityEncryption',el='table-block',enum={'none':'Disabled','psk2+ccmp':'Enabled','psk2+ccmp-256':'Enabled'}),
        mib('RTX Percentage','wirelessStatsRTXPercent',el='table-block',units='%'),
        mib('Remote Partners','wirelessStatsRemotePartners',el='table-block'),
    ],layout='matrix',column='right',heading='Summary',matrix={'hideEmptyColumns':False,'columns':cols()}))

    # ============ Wireless > Radio 1 (wifi1, table row 2, link profile 2.1) ============
    def active_ch(row,web): return tpl('Active Channel','{c} ( {f} MHz )',[('c','wirelessActiveChannel',row),('f','wirelessActiveFrequency',row)],web=web)
    def conf_ch(row,page,aaa):
        return mib('Configured Channel','wirelessChannel',row,enum=web_enum(page,'Configured Channel'),web=(page,'Configured Channel'))
    P='wireless_radio1'
    S.append(section('Wireless','Radio 1','Properties','Properties',[
        mib('Status','wirelessRadioStatus',2,enum=web_enum(P,'Status'),web=(P,'Status')),
        mib('Link Type','wirelessLinktype',2,enum=web_enum(P,'Link Type'),web=(P,'Link Type')),
        mib('Radio Mode','wirelessRadioMode',2,enum=web_enum(P,'Radio Mode'),web=(P,'Radio Mode')),
        mib('SSID','wirelessSSID',2,web=(P,'SSID')),
        mib('Bandwidth','wirelessBandwidth',2,enum=web_enum(P,'Bandwidth'),web=(P,'Bandwidth')),
        conf_ch(2,P,0),
        active_ch(2,(P,'Active Channel')),
        mib('Encryption','wirelessSecurityEncryption',2,enum=web_enum(P,'Encryption'),web=(P,'Encryption')),
        static('Key',web=(P,'Key')),static('Network Secret',web=(P,'Network Secret')),
        mib('Distance','wirelessDistance',2,web=(P,'Distance')),
        mib('DL/UL Ratio','wirelessDlUlRatio',2,enum=web_enum(P,'DL/UL Ratio'),web=(P,'DL/UL Ratio')),
    ],layout='form',heading='Radio 1 Configuration',note=NOTE_W))
    P='wireless_radio1_ddrs1'
    S.append(section('Wireless','Radio 1','DDRS/ATPC','DDRS/ATPC',[
        mib('DDRS Status','linkProfileDDRSStatus','2.1',enum=web_enum(P,'DDRS Status'),web=(P,'DDRS Status')),
        mib('Spatial Stream','linkProfileSpatialStream','2.1',enum=web_enum(P,'Spatial Stream'),web=(P,'Spatial Stream')),
        mib('Modulation Index','linkProfileTxRate','2.1',enum=web_enum(P,'Modulation Index'),web=(P,'Modulation Index')),
        mib('Transmit Power','linkProfilePower','2.1',web=(P,'Transmit Power')),
        mib('Maximum EIRP','wirelessMaximumEIRP',2,web=(P,'Maximum EIRP')),
        mib('Connectorized Antenna Gain','wirelessAntennaGain',2,web=(P,'Connectorized Antenna Gain')),
    ],layout='form',heading='Radio 1 Configuration'))
    P='wireless_radio1_dcs1'
    S.append(section('Wireless','Radio 1','DCS','DCS',[
        mib('DCS Status','dcsStatus',2,enum=web_enum(P,'DCS Status'),web=(P,'DCS Status')),
        mib('RTX Threshold','dcsThreshold',2,web=(P,'RTX Threshold')),
    ],layout='form',heading='Radio 1 Configuration'))
    P='wireless_radio1_shaping1'
    S.append(section('Wireless','Radio 1','Shaping','Shaping',[
        mib('Traffic Shaping','wirelessTrafficShaping',2,enum=web_enum(P,'Traffic Shaping'),web=(P,'Traffic Shaping')),
        mib('Incoming Traffic Limit','wirelessDownlinkLimit',2,web=(P,'Incoming Traffic Limit')),
        mib('Outgoing Traffic Limit','wirelessUplinkLimit',2,web=(P,'Outgoing Traffic Limit')),
    ],layout='form',heading='Radio 1 Configuration'))
    # ============ Wireless > 2.4 GHz (wifi0, table row 1) ============
    P='wireless_radio0'
    S.append(section('Wireless','2.4 GHz Radio','Properties','Properties',[
        mib('Status','wirelessRadioStatus',1,enum=web_enum(P,'Status'),web=(P,'Status')),
        tpl('Radio Mode','{m}',[('m','wirelessRadioMode',1,{'map':{'ap':'AP','sta':'STA'}})],web=(P,'Radio Mode')),
        mib('SSID','wirelessSSID',1,web=(P,'SSID')),
        mib('Bandwidth','wirelessBandwidth',1,enum=web_enum(P,'Bandwidth'),web=(P,'Bandwidth')),
        mib('Configured Channel','wirelessChannel',1,enum=web_enum(P,'Configured Channel'),web=(P,'Configured Channel')),
        active_ch(1,(P,'Active Channel')),
        mib('Encryption','wirelessSecurityEncryption',1,enum=web_enum(P,'Encryption'),web=(P,'Encryption')),
        static('Key',web=(P,'Key')),
    ],layout='form',heading='2.4 GHz Configuration',note=NOTE_W))

    # ============ Network ============
    P='network_ip'
    S.append(section('Network','IP Configuration','5 GHz Radio','IP Configuration',[
        mib('Address Type','networkAddressType',enum=web_enum(P,'Address Type'),web=(P,'Address Type')),
        mib('MTU','ethernetMTU',web=(P,'MTU')),
        mib('Mgmt VLAN ID','vlanMgmtId',web=(P,'Mgmt VLAN ID')),
        mib('IP Address','networkIPAddress',web=(P,'IP Address',0)),
        mib('Subnet Mask','networkNetMask',web=(P,'Subnet Mask')),
        mib('Gateway','networkGateway',web=(P,'Gateway',0)),
        mib('IP Address (IPv6)','networkIPv6IPAddress',web=(P,'IP Address',1)),
        mib('Gateway (IPv6)','networkIPv6Gateway',web=(P,'Gateway',1)),
    ],layout='form',heading='IP Configuration'))
    P='network_ip_ip24'
    S.append(section('Network','IP Configuration','2.4 GHz Radio','IP Configuration (2.4 GHz)',[
        mib('IP Address','network24IPAddress',web=(P,'IP Address')),
        mib('Subnet Mask','network24NetMask',web=(P,'Subnet Mask')),
    ],layout='form',heading='IP Configuration'))
    P='network_radius1'
    S.append(section('Network','RADIUS','RADIUS','RADIUS',[
        mib('Status','radiusStatus',enum={**web_enum(P,'Status'),'-1':'Disable'},web=(P,'Status')),   # the agent reports -1 (never configured); the device UI calls it Disable
        mib('Primary Server','radiusPrimaryServer',web=(P,'Primary Server')),
        mib('Primary Server Port','radiusPrimaryPort',web=(P,'Primary Server Port')),
        static('Primary Shared Secret',web=(P,'Primary Shared Secret')),
        mib('Secondary Server','radiusSecondaryServer',web=(P,'Secondary Server')),
        mib('Secondary Server Port','radiusSecondaryPort',web=(P,'Secondary Server Port')),
        static('Secondary Shared Secret',web=(P,'Secondary Shared Secret')),
        mib('Reauthentication Time','radiusAuthenticationTime',web=(P,'Reauthentication Time')),
        mib('Retry Time','radiusRetryTime',web=(P,'Retry Time')),
        mib('Retry Count','radiusRetryCount',web=(P,'Retry Count',0)),
        mib('Retry Count Period','radiusRetryCountPeriod',web=(P,'Retry Count Period')),
    ],layout='form',heading='RADIUS Configuration'))
    P='network_vlan'
    S.append(section('Network','VLAN','VLAN','VLAN',[
        mib('Mode','vlanMode',enum=web_enum(P,'Mode'),web=(P,'Mode')),
    ],layout='form',heading='VLAN Configuration'))
    P='network_eth'
    S.append(section('Network','Ethernet','LAN 1','LAN 1',[
        mib('Speed / Duplex','ethMode',1,enum=web_enum(P,'Speed / Duplex'),web=(P,'Speed / Duplex')),
    ],layout='form',heading='Ethernet Configuration'))
    P='network_eth1'
    S.append(section('Network','Ethernet','LAN 2','LAN 2',[
        mib('Speed / Duplex','ethMode',2,enum=web_enum(P,'Speed / Duplex'),web=(P,'Speed / Duplex')),
    ],layout='form',heading='Ethernet Configuration'))
    P='network_dhcp'
    S.append(section('Network','DHCP / Leases','Server','Server',[
        mib('DHCP Server','dhcpServer',enum=web_enum(P,'DHCP Server'),web=(P,'DHCP Server')),
        mib('Start IPv4 Address','dhcpStartIP',web=(P,'Start IPv4 Address')),
        mib('End IPv4 Address','dhcpEndIP',web=(P,'End IPv4 Address')),
        mib('Lease Time','dhcpLeaseTime',web=(P,'Lease Time')),
    ],layout='form',heading='DHCP / Leases'))
    P='network_dhcp_dhcp24'
    S.append(section('Network','DHCP / Leases','2.4 GHz Radio','2.4 GHz Radio',[
        mib('DHCP Server','dhcp24Server',enum=web_enum(P,'DHCP Server'),web=(P,'DHCP Server')),
        mib('Start IP Address','dhcp24StartIP',web=(P,'Start IP Address')),
        mib('End IP Address','dhcp24EndIP',web=(P,'End IP Address')),
        mib('Lease Time','dhcp24LeaseTime',web=(P,'Lease Time')),
    ],layout='form',heading='DHCP / Leases'))

    # ============ Management ============
    P='system_system'
    S.append(section('Management','System','General','General',[
        tpl('Local Time','{t}',[('t','ntpLocalTime',None,{'strip':' [A-Z]{2,4}(?= \\d{4}$)'})],web=(P,'Local Time')),
        mib('Timezone','ntpTimeZone',enum={m.group(2):m.group(1) for o in [x for x in WEB[P]['fields'] if x['label']=='Timezone'][0]['options'] for m in [re.match(r'^(.*)\(([^()]*)\)$',o)] if m},web=(P,'Timezone')),
    ],layout='form',heading='System'))
    P='system_system_logging'
    S.append(section('Management','System','Logging','Logging',[
        mib('Server IP Address','syslogServerIP',web=(P,'Server IP Address')),
        mib('Server Port','syslogServerPort',web=(P,'Server Port')),
        mib('Status','tempLogStatus',enum=web_enum(P,'Status'),web=(P,'Status')),
        mib('Interval','tempLogInterval',web=(P,'Interval')),
    ],layout='form',heading='System'))
    P='system_system_location'
    S.append(section('Management','System','Location','Location',[
        mib('BTS ID','wirelessCustomerName',1,web=(P,'BTS ID')),
        mib('Site ID','sysInfoLocation',web=(P,'Site ID')),
        mib('Email','sysInfoEmail',web=(P,'Email')),
        mib('Phone Number','sysInfoContact',web=(P,'Phone Number')),
    ],layout='form',heading='System'))
    P='system_system_gps'
    S.append(section('Management','System','GPS','GPS',[
        mib('Latitude','sysInfoGeolat',ro=True,web=(P,'Latitude')),
        mib('Longitude','sysInfoGeolong',ro=True,web=(P,'Longitude')),
        mib('Elevation','sysInfoGeoAltitude',ro=True,web=(P,'Elevation')),
        mib('Time','sysInfoGeoTime',ro=True,web=(P,'Time')),
        mib('Satellite Count','sysInfoSatellite',ro=True,web=(P,'Satellite Count')),
    ],layout='form',heading='System'))
    S.append(section('Management','Services','Passwords','Passwords',[
        static('Admin Password',web=('system_services','Admin Password')),static('User Password',web=('system_services','User Password')),static('Installer Password',web=('system_services','Installer Password')),
    ],layout='form',heading='Services'))
    P='system_services_ssh'
    S.append(section('Management','Services','SSH','SSH',[
        mib('SSH Status','sshStatus',web=(P,'SSH Status')),
    ],layout='form',heading='Services'))
    P='system_services_snmp'
    S.append(section('Management','Services','SNMP','SNMP',[
        mib('Version','snmpVersion',enum=web_enum(P,'Version'),web=(P,'Version')),
        static('Read Password',web=(P,'Read Password')),static('Read Write Password',web=(P,'Read Write Password')),
        mib('Status','snmpV3Status',enum=web_enum(P,'Status'),web=(P,'Status')),
        static('Security Name','rwv3user',web=(P,'Security Name')),static('Security Level','authPriv',web=(P,'Security Level')),
        static('Auth Passphrase',web=(P,'Auth Passphrase')),static('Auth Protocol','SHA',web=(P,'Auth Protocol')),
        static('Privacy Passphrase',web=(P,'Privacy Passphrase')),static('Privacy Protocol','AES',web=(P,'Privacy Protocol')),
    ],layout='form',heading='Services'))
    return S
