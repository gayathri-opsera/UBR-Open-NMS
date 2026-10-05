# Definition-Driven Live Node View — End-to-End Flow

This document describes how a device goes from an **uploaded product-definition file**
(XML or JSON) to a **live, definition-driven Node View** and a position on the
**topology map**. It also records the problems that were found and fixed in the
original implementation, how the result was verified against a real device, and what is
still not covered.

> **Core rule of this flow:** only the fields declared in the uploaded product definition
> are read from the device, stored, and shown in the Node View. Nothing is added from
> built-in lists, hardcoded aliases, or other data sources. A parameter that has no OID in
> the definition is shown as *unmapped*; a value the device does not return is shown as
> *no such object* — never guessed or filled in.

- [1. Overview](#1-overview)
- [2. Architecture](#2-architecture)
- [3. Step-by-step flow](#3-step-by-step-flow)
- [4. Data model](#4-data-model)
- [5. APIs](#5-apis)
- [6. XML-only principle — what is and is not shown](#6-xml-only-principle--what-is-and-is-not-shown)
- [7. GPS coordinates and topology](#7-gps-coordinates-and-topology)
- [8. What was broken and how it was fixed](#8-what-was-broken-and-how-it-was-fixed)
- [9. Verification against the real device](#9-verification-against-the-real-device)
- [10. Operating the stack locally](#10-operating-the-stack-locally)
- [11. Known limitations and open items](#11-known-limitations-and-open-items)
- [12. Background: how comparable systems do it](#12-background-how-comparable-systems-do-it)
- [13. Files changed](#13-files-changed)

---

## 1. Overview

The operator-facing flow is:

```
Framework → Product Definitions        Operations → Discovery        Inventory → Device
 upload XML/JSON → Stage → Activate  →  scan a device range  →  Provision  →  Node View
                                                                              Topology (map)
```

1. **Upload** a definition file. The service parses it into groups, sub-groups and
   parameters (each with an OID, type, enum labels, widget, order).
2. **Stage** and **Activate** it. Activation builds the *parameter registry* the rest of
   the system reads.
3. **Discover** a device by IP. Discovery links the device to the active definition and
   triggers a first live read.
4. **Provision** the device (or let the discovery auto-provision path do it). The device
   record keeps its definition link and the SNMP credential discovery used.
5. **Node View** shows every parameter of the definition with live values read from the
   device. **Topology** plots the device using the coordinates on its record.

## 2. Architecture

```
                         ┌───────────────────────────────────────────────┐
  Operator (browser)     │  Frontend (React, nginx)  :5173               │
  ───────────────────────►  Product Definitions page · Discovery · Node View
                         └───────────────┬───────────────────────────────┘
                                         │ /api/*
                         ┌───────────────▼───────────────────────────────┐
                         │  API Gateway (Node/Express)  :3100            │
                         │   • framework product-definition proxy (RBAC)│
                         │   • discovery.stub.js  (scan + auto-provision)│
                         │   • provision.stub.js  (manual provision)     │
                         │   • frameworkParameters.routes.js             │
                         │        ui-template · parameters/current       │
                         │   • src/live/  ── live SNMP read module       │
                         └───┬─────────────┬───────────────┬─────────────┘
                             │             │               │ read-only SNMP walk (UDP/161)
                ┌────────────▼───┐  ┌──────▼───────┐  ┌────▼─────────────┐
                │ product-       │  │   MongoDB    │  │  Network device  │
                │ definition-    │  │ ubrnms       │  │  (e.g. UBR655)   │
                │ service (Java) │  │ ubrnms_      │  └──────────────────┘
                │ parse/validate │  │  productdef  │
                │ lifecycle      │  └──────────────┘
                └────────────────┘
```

| Component | Responsibility in this flow |
|---|---|
| `product-definition-service` (Java/Spring) | Parses uploads, validates, runs the DRAFT → STAGED → ACTIVE lifecycle, builds the **parameter registry** and **fingerprint registry** in `ubrnms_productdef`. |
| `api-gateway` (Node) | Discovery scan, provisioning, `ui-template` and `parameters/current` APIs, and the **live read module** (`src/live/`). |
| MongoDB `ubrnms_productdef` | Definition versions, active-version pointers, `parameter_registry_entries`, `fingerprint_registry_entries`. |
| MongoDB `ubrnms` | `devices` (inventory/topology source) and `device_parameter_values` (latest live values per device). |
| Frontend | Product-definition admin page, discovery UI, device **Node View**, topology maps. |

> The Go `parameter-poller` service exists in the repository but is **not** part of this
> flow. Live reads are done by the gateway module described below.

## 3. Step-by-step flow

### 3.1 Upload (Framework → Product Definitions)

`POST /api/v1/framework/product-definitions/upload` (multipart, SuperAdmin).

The gateway streams the file to `product-definition-service`, which:

1. Computes a SHA-256 content hash and **rejects an identical file** that was uploaded
   before (HTTP 422, `UPLOAD_REJECTED`).
2. Picks a parser by content type (`XmlProductDefinitionParser`,
   `JsonProductDefinitionParser`, `XlsProductDefinitionParser`).
3. Normalises the file into a `NormalizedProductDefinition`.
4. Validates it and stores a new **version** in state `DRAFT`.

What the parsers read from a parameter:

| Field | XML element | JSON key | Stored as |
|---|---|---|---|
| Id | `id` attribute | `id` | `parameterId` (duplicates inside a group are prefixed with the sub-group, e.g. `dhcp_2_4_ipAddress`) |
| Label | `<name>` | `name` | `displayName` |
| Group / sub-group | `<parameterGroup id=…>` / `<subGroup>` | `group` / `subGroup` | `groupId` / `subGroup` |
| Type | `<dataType>` | `dataType` | `dataType` (`enum`, `string`, `uint`→`INTEGER`, `ipv4`/`ipv6`→`IPADDRESS`) |
| Widget | `<uiWidget>` | `uiWidget` | `uiWidget` |
| Read-only | `<readOnly>` | `readOnly` | `readOnly` |
| OID | `<oid>` | `oid` (or `snmpMapping.oid`) | `snmpOid` |
| Enum labels | `<enumValues><value>` | `enumValues[]` | `enumValues` (kept verbatim, e.g. `Enable(0)`) |
| Range / default | `<minValue>` `<maxValue>` `<defaultValue>` | same | same |
| Order | document order | document order | `displayOrder` (1…n within the group) |

### 3.2 Stage and Activate

`PUT …/{definitionId}/versions/{versionId}/stage` then `…/activate`.

Activation (`ProductDefinitionLifecycleService`) runs the publish gates, **deletes and
rebuilds** both registries for the definition, bumps `registryVersion`, writes the
`product_definition_active_versions` pointer and publishes a lifecycle event.

- `parameter_registry_entries` — one document per parameter (see [§4](#4-data-model)).
- `fingerprint_registry_entries` — one per fingerprint **present in the file**. A file
  with only banner fingerprints produces only banner entries; no OID fingerprint is
  invented.

### 3.3 Discovery (Operations → Discovery)

Single-IP scans are handled by the gateway (`discovery.stub.js`, "ICMP-bypass" path):

1. Sends an SNMP v2c GET for the MIB-II system group to the target, using the community
   from the request or a saved credential.
2. Classifies the device (OID map, banner fingerprints, `sysDescr` keywords). When an
   operator selects a template, that template's definition is applied.
3. **Links the device to an active definition.** The candidate definition id (which may be
   stale, e.g. from the built-in OID map) is validated against the *active* registry and,
   if it has none, replaced by the single active definition of the same vendor.
4. Upserts the device record in `ubrnms.devices` with the definition id, SNMP port and the
   credential used, then **triggers a first live read** (fire-and-forget).

CIDR scans are forwarded to the Go `discovery-service`, which additionally reads device
role and GPS from vendor attribute profiles (see [§7](#7-gps-coordinates-and-topology)).

### 3.4 Provision

`POST /api/v1/discovery/runs/{runId}/provision` (`provision.stub.js`):

- Resolves the device against the fingerprint registries (banner, OID prefix, built-in map)
  and then **validates the resulting definition id against the active registry**; a stale id
  is replaced by the vendor's single active definition.
- Carries the SNMP credential over from the discovery record at the same IP (a saved
  `credentialId` on the host is also honoured; a community sent directly in the request body
  is deliberately **not** accepted).
- Writes the device (`productDefinitionId`, `snmpPort`, `snmpCommunity`) and triggers a
  first live read.

A device whose definition cannot be resolved is still provisioned; its Node View shows
"No Product Definition linked" and its poll status is reported honestly.

### 3.5 Live read

Implemented in `services/api-gateway/src/live/` (`liveParameters.js`, `snmpWalk.js`).

1. **Load the definition**: the *active* version's `parameter_registry_entries`.
2. **Compute walk roots** (`walkRoots`): the parameters' OIDs are grouped by enterprise
   root and each group is walked from its longest common prefix. One walk therefore covers
   the whole definition instead of one request per parameter.
3. **Walk** the subtree with read-only SNMP v2c GETNEXT/GETBULK (`net-snmp`). No SET is
   ever issued.
4. **Map** each returned OID to the definition parameter whose OID is its longest prefix
   (`mapVarbinds`). The remainder of the OID is the **row index**:
   - `…OID.0` → scalar (no index)
   - `…OID.1`, `.2`, `.3` → table rows (e.g. one value per radio)
   - `…OID.2.1` → two-level index
   Several parameters may legitimately share one OID.
5. **Persist** the latest values in `ubrnms.device_parameter_values` (one document per
   device). On a failed poll the previous values are kept and the failure is recorded.
6. **GPS hook**: if the definition declares parameters with the ids `latitude` and
   `longitude`, valid live values are written to the device record
   ([§7](#7-gps-coordinates-and-topology)).

When values are refreshed:

| Trigger | Detail |
|---|---|
| Provisioning | immediately after the device is written |
| Discovery auto-provision | immediately after the device is written |
| Opening the Node View | `GET …/parameters/current` re-polls if stored data is older than 15 s |
| Refresh button | `?refresh=1` forces a re-poll |
| Scheduler | every 60 s for every non-deprovisioned device that has a stored credential (`LIVE_POLL_INTERVAL_SECONDS`, `LIVE_POLL_DISABLED=true` turns it off) |

Concurrent refreshes of the same device share a single walk.

### 3.6 Node View (Inventory → Device → Node View)

The page calls two APIs and renders the result:

- `GET /api/framework/v1/devices/{id}/ui-template` — structure (groups, sub-groups,
  parameters, widgets, enum labels, read-only flags).
- `GET /api/framework/v1/devices/{id}/parameters/current` — live values.

Rendering (`frontend/src/v2/components/NodeViewParameters.tsx`):

- One **card per group**, in definition order.
- Inside a card, one **section per sub-group**; each is a table with one row per parameter.
- For tables (e.g. per-radio values) there is **one column per SNMP row index**
  (`#1`, `#2`, `#3`, or `#2.1`…). Scalars span the columns.
- The value shown is the enum label from the definition when the raw value matches a
  `Label(n)` entry, otherwise the raw value.
- States: stale or failed values are muted with a badge; unmapped parameters show `—`
  with the tooltip "no OID in product definition".
- A status strip shows device status, definition id and registry version, last poll time,
  poll status (`OK`, `UNREACHABLE`, `NO_CREDENTIALS`, `NOT_POLLED`, `ERROR`) and a
  **Refresh** button. The page refreshes itself every 30 s while the tab is visible.

The Node View no longer contains hardcoded parameter-id aliases, hardcoded group
partitioning, KPI charts or the availability badge.

### 3.7 Topology

The topology API (`topology.stub.js`) merges the inventory service and `ubrnms.devices`.
Each device's position comes from `latitude`/`longitude` on its record — see
[§7](#7-gps-coordinates-and-topology) for where those come from and what happens when they
are missing.

## 4. Data model

**`ubrnms_productdef.parameter_registry_entries`** (one document per parameter)

| Field | Meaning |
|---|---|
| `productDefinitionId`, `versionId`, `registryVersion` | which definition/version produced it |
| `groupId`, `subGroup`, `parameterId`, `displayName` | placement and identity |
| `dataType`, `unit`, `defaultValue`, `minValue`, `maxValue`, `enumValues` | typing |
| `snmpOid` | OID to read (null → *unmapped*) |
| `uiWidget`, `readOnly`, `displayOrder`, `uiVisibleTo` | presentation / visibility |

**`ubrnms.devices`** — adds/uses: `productDefinitionId`, `snmpPort`, `snmpCommunity`,
`latitude`, `longitude`, `locationSource`.

**`ubrnms.device_parameter_values`** (one document per device)

```json
{
  "_id": "<deviceId>", "productDefinitionId": "...", "versionId": "...", "registryVersion": "5",
  "pollStatus": "OK | UNREACHABLE | NO_CREDENTIALS | NOT_POLLED | ERROR",
  "pollError": null, "collectedAt": "<last successful poll>", "lastAttemptAt": "<last attempt>",
  "values": [ { "groupId": "radio", "parameterId": "ssid",
                "instances": [ { "index": "1", "raw": "…" }, { "index": "2", "raw": "…" } ] } ]
}
```

## 5. APIs

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/framework/product-definitions/upload` | Upload a definition (SuperAdmin) |
| `PUT /api/v1/framework/product-definitions/{def}/versions/{ver}/stage` | Stage a valid draft |
| `PUT /api/v1/framework/product-definitions/{def}/versions/{ver}/activate` | Activate; rebuilds registries |
| `POST /api/v1/discovery/runs` | Start discovery (`scope`, `community` or `credentialId`, `productDefinitionId`) |
| `POST /api/v1/discovery/runs/{runId}/provision` | Provision discovered hosts |
| `GET /api/framework/v1/devices/{id}/ui-template` | Structure of the Node View (from the **active** definition only) |
| `GET /api/framework/v1/devices/{id}/parameters/current[?refresh=1]` | Live values, with `freshnessState` and `readStatus` per parameter |

`parameters/current` per-parameter fields: `value`, `display`, `isTable`,
`instances[{index,value,display}]`, `freshnessState` (`FRESH|STALE|UNMAPPED|FAILED`),
`readStatus` (`SUCCESS|UNMAPPED|NO_SUCH_OBJECT|UNREACHABLE|UNKNOWN`), `collectedAt`,
`failureReason`. Parameter visibility (`uiVisibleTo`) is enforced server-side for both
endpoints using the caller's JWT role.

## 6. XML-only principle — what is and is not shown

**Currently only the fields present in the uploaded XML/JSON are considered.** Concretely:

| Aspect | Behaviour |
|---|---|
| Which parameters appear | Exactly the parameters of the **active** definition — no others |
| Which OIDs are read | Only the OIDs written in the definition; the walk root is derived from them |
| Parameters without an OID | Listed, shown as **unmapped** (`—`); no OID is guessed |
| OIDs the device does not answer | Shown as **no such object**; no default is substituted |
| Labels, enum names, widgets, order, sub-grouping | Taken from the file |
| Row labels for table columns | Neutral SNMP row indexes (`#1`, `#2`, …) — names such as "radio0" are **not** invented |
| Other device data (CPU, memory, temperature, link statistics, neighbours, logs, QoS tables, GPS display, …) | **Not shown** unless the definition declares an OID for it |
| Hardcoded alias lists / KPI charts / availability badge | **Removed** from the Node View |
| Definition for a device | Only its own linked definition — there is no "first active definition" fallback |

Example: the device exposes ~786 values under its enterprise subtree; the sample file
declares 55 parameters (53 with OIDs), so the Node View shows exactly those 55 rows and
nothing else. To show more, **add the parameters to the XML** and re-upload.

The Device Identity block on the page still shows inventory fields (id, vendor, model, IP,
serial number, …). Those come from discovery/inventory, not from the definition, and show
`—` when absent.

## 7. GPS coordinates and topology

Coordinates can enter the system in five ways. Only the first is a real-time device read.

| # | Source | Live? | Status for the verified device |
|---|---|---|---|
| 1 | **Definition parameters** with ids `latitude` and `longitude` (and OIDs): each live poll validates them (range, not 0/0) and writes them to the device record with `locationSource` | Yes | The sample file has none → never fires |
| 2 | Static `<location>` block in the definition, copied to matching devices | No (planned position) | The sample file has none |
| 3 | Go `discovery-service`: vendor GPS OIDs or a `"lat,lng"` pair in `sysLocation` (CIDR scans only) | At discovery | Not used for single-IP scans; EOC profile has no GPS OIDs; `sysLocation` is "office" |
| 4 | Operator entry in the provision dialog (prefilled from #2 when present) | No | — |
| 5 | Topology fallback: devices without coordinates are placed near a hardcoded city anchor and flagged `approximateLocation` | No (guess) | What the map currently shows |

The verified device reports GPS as "- -" (no fix) and no GPS OID exists in its SNMP tree
(walked: enterprise subtree of 787 values plus a partial look at other subtrees). Its web UI
refers to `system.gps.set_latitude` / `set_longitude`, suggesting manually configured
coordinates, but no SNMP source for them was found.

**To get real-time GPS:** find the GPS OIDs (vendor MIB, or a full walk once the device has
a fix or configured coordinates), add `latitude` / `longitude` parameters with those OIDs to
the XML, and re-upload. No code change is needed. If the device exposes GPS only through its
web UI, an HTTP adapter would be required; none exists today.

Topology rules in the gateway: device-reported coordinates are used as-is; only devices
without real coordinates get an approximate placement (flagged), and only real coordinates
count as "located" on the V2 map.

## 8. What was broken and how it was fixed

| # | Problem | Fix |
|---|---|---|
| 1 | XML parser matched the `<group>radio</group>` text inside every parameter instead of the `<parameterGroup>` elements → 55 groups named "default", 0 parameters | Groups and parameters are read as direct children (`directChildrenAny`) |
| 2 | JSON parser read the OID only from `snmpMapping.oid`; the sample uses a top-level `oid` → every OID null | Accepts top-level `oid`/`snmpOid` as well |
| 3 | `uiWidget`, `readOnly`, `subGroup` were parsed then discarded; registry hard-coded `readOnly=false`, `displayOrder` never set | Added to the model and registry; document order recorded as `displayOrder` |
| 4 | `ui-template` queried database `ubrnms`, but the registry lives in `ubrnms_productdef` → always "no active framework"; also fell back to the first active definition | Reads the registry DB, uses only the device's own (active) definition |
| 5 | Device ↔ definition link missing or stale (`Configurations_GUI` vs active `eoc-configurations-gui`); no credential kept at provisioning | Link validated against the active registry and healed by vendor; credential carried over from discovery |
| 6 | Live reads: poller never reached the registry (wrong env var), polled no devices, did single GETs on bare OIDs that fail for table columns, kept values in memory only | New gateway module: one subtree walk per device, row indexes kept, values persisted in MongoDB |
| 7 | Node View used hardcoded aliases, group-name heuristics, KPI charts | Rebuilt from the definition (group → sub-group → table with instance columns) |
| 8 | `parameters/current` proxied to the unused poller | Served from the live module |

## 9. Verification against the real device

Device: EOC UBR655 (enterprise OID `1.3.6.1.4.1.52619`), three radios, reachable over SNMP
and its LuCI web UI.

- **Parsing:** the sample XML now yields 2 groups (radio 27, network 28), 55 parameters,
  53 OIDs, with sub-group and widget on every parameter. Sub-group counts: radio
  {properties 12, ddrs 8, atpc 3, aptc 1, dcs 3}, network {ip_configuration 6, vlan 10,
  ethernet 2, dhcp 4, dhcp_2_4 6}.
- **Lifecycle:** upload → stage → activate succeeded; registry version 5 with 55 entries
  (53 with OIDs, 55 with sub-groups).
- **Device SNMP:** 53 of the 55 XML OIDs answer on the device; 37 of them are table columns
  needing a row index (the earlier single-GET design could not read these).
- **Cross-check with the device web UI:** 38 fields present on both sides compared;
  **36 match**. The 2 differences are MTU (device SNMP agent returns `0`, its web UI shows
  `1500`) — verified directly with `snmpwalk`, i.e. the NMS relays what the device reports.
- **Browser check:** the Node View rendered all groups and sub-groups with per-radio columns
  and no console errors.
- **Discovery:** a real discovery run with the template selected linked the device to the
  active definition and stored 53 values immediately.
- **Provisioning:** throwaway records confirmed (a) a stale definition id is replaced by the
  active one, (b) the credential is carried over from the discovery record, and (c) a device
  without a credential reports `NO_CREDENTIALS` instead of showing data. Test records were
  removed afterwards.
- **Automated tests:** 21 new gateway unit tests (`tests/unit/liveParameters.test.js`) and new
  Java tests (`OperatorSampleDefinitionTest` and additions to the parser/registry tests) pass.
  Pre-existing failures, identical on a clean copy of `HEAD`: 6 in the Java service (schema/
  namespace strictness and a null-`sysObjectId` fingerprint case) and 3 in the gateway
  (`provision-deprovision-cascade`).

## 10. Operating the stack locally

Deploy only the changed services; use the env file and the host-network build override
(container DNS on this lab cannot resolve public hosts):

```bash
# throwaway override, not committed
cat > /tmp/build-host-net.yml <<'EOF'
services:
  product-definition-service: { build: { network: host } }
  api-gateway:                { build: { network: host } }
  frontend:                   { build: { network: host } }
EOF

docker compose -f docker-compose.dev.yml -f /tmp/build-host-net.yml \
  --env-file dev/.env.dev up -d --build --no-deps \
  product-definition-service api-gateway frontend

# the frontend's nginx resolves the gateway once at start-up
docker restart nms-frontend
```

Verify: `POST /api/v1/auth/login` through `:5173` with bad credentials must return **401**
(not 502). The token in the real login response is at `data.accessToken`.

Re-uploading a definition: an identical file is rejected as a duplicate. After a parser fix,
upload a copy with an added XML comment line (the parsed content is unchanged) instead of
deleting version history.

Useful checks:

```bash
# live values for a device (token from the login response)
curl -s "localhost:3100/api/framework/v1/devices/<deviceId>/parameters/current?refresh=1" \
     -H "Authorization: Bearer $TOKEN"

# raw device values for comparison (community stored on the device record)
snmpwalk -v2c -c <community> -On <device-ip> .1.3.6.1.4.1.52619.1.1
```

Configuration knobs (gateway): `LIVE_POLL_INTERVAL_SECONDS` (default 60),
`LIVE_POLL_DISABLED`, `PRODUCTDEF_DB_NAME` (default `ubrnms_productdef`).

## 11. Known limitations and open items

1. **No real-time GPS for the verified device** — see [§7](#7-gps-coordinates-and-topology).
2. **Wi-Fi keys are displayed in plaintext.** A parameter such as `Key` is shown to every
   viewer; the definition format has no "secret" flag. Recommended: add a flag and mask such
   values (and restrict via `uiVisibleTo`).
3. **Credentials are stored in plain text** on the device record (`snmpCommunity`), as the
   existing discovery path already did. Encrypting (the gateway has `aesEncrypt`) or moving
   to the credential vault is recommended.
4. **Writes do not work.** The Parameters tab's write path proxies to a poller route that does
   not exist; there is no SNMP SET anywhere. The Node View is read-only.
5. **The old Go `parameter-poller` is unused** and still misconfigured (wrong env var, no
   device enumeration, in-memory store). Remove it or fix it deliberately.
6. **Duplicate device records** from earlier manual runs (e.g. two records for one IP, one
   without credentials) are not cleaned automatically.
7. **Parameters without an OID** (in the sample: `ofdma`, `connectorizedAntennaGain`) stay
   unmapped until the XML gives them one.
8. **Some enum values show raw numbers** when the definition's labels do not carry a matching
   `(n)` suffix (shown as received, not guessed).
9. **Dedupe by content hash** blocks re-uploading identical content after a parser fix.
10. **Pre-existing test failures** listed in [§9](#9-verification-against-the-real-device) were
    not addressed.
11. **Frontend lint/type check** was verified through the Docker build only; `oxlint` was not run.
12. **Not covered by the definition format:** tables as first-class objects (neighbours, ARP,
    learn table), per-instance names (radio/port labels), read-only monitoring values
    (link statistics, CPU/memory), units. Adding these to the format is the next step if
    those need to appear in the Node View.

## 12. Background: how comparable systems do it

Two reference systems were reviewed for the discovery → inventory flow.

**NetBox Labs (Orb agent + Diode):** discovery agents send entities to an ingestion service
that matches and reconciles them; Diode supports a staging *branch* with review before merge.
Role, site and GPS are **not** auto-discovered; they come from policy `defaults`.
Gaps relative to this NMS: no staging/approval before provisioning, no reconciliation
report on re-discovery, a shallower inventory model (device only; no interfaces/IPs/VLANs),
no GitOps policies, no drift detection.

**OpenNMS (Provisiond):** discovered nodes land in a *requisition* and are reviewed before
**Synchronize**; policies and detectors control what is persisted; rescans run continuously;
Minions scan remote locations.
Gaps relative to this NMS: no review step between discovery and inventory, no declarative
policy layer, no remote collectors, no per-service detection.

Common theme worth considering: a **pending-review stage** between discovery and inventory.

## 13. Files changed

**Product-definition service** (`services/product-definition-service`)
- `model/NormalizedProductDefinition.java`, `model/ParameterRegistryEntry.java` — new fields
  (`subGroup`, `uiWidget`, `readOnly`, `displayOrder`).
- `validation/XmlProductDefinitionParser.java`, `validation/JsonProductDefinitionParser.java` —
  group/parameter parsing, top-level OID, new fields.
- `service/ParameterRegistryBuilder.java` — carries the new fields; per-group uniqueness.
- Tests: `OperatorSampleDefinitionTest` (+ sample resources) and additions to
  `XmlProductDefinitionParserTest`, `JsonProductDefinitionParserTest`,
  `ParameterRegistryBuilderTest`.

**API gateway** (`services/api-gateway`)
- `src/live/snmpWalk.js` *(new)* — read-only SNMP subtree walk.
- `src/live/liveParameters.js` *(new)* — registry loading, OID mapping, persistence,
  scheduler, `parameters/current` builder, definition-link healing.
- `src/routes/frameworkParameters.routes.js` — `ui-template` and `parameters/current` rewritten.
- `src/routes/provision.stub.js`, `src/routes/discovery.stub.js` — definition link,
  credential carry-over, first live read.
- `src/server.js` — starts the scheduler; `package.json` — adds `net-snmp`.
- `tests/unit/liveParameters.test.js` *(new)*.

**Frontend** (`frontend/src`)
- `v2/components/NodeViewParameters.tsx` *(new)* — definition-driven renderer.
- `v2/pages/V2DeviceDetailPage.tsx` — Node View rebuilt; hardcoded aliases and KPI removed.
- `v2/components/framework/parameters/ParameterValueCard.tsx` — lists all instances.
- `api/framework-panels.types.ts`, `api/framework-parameters.types.ts`,
  `api/framework-parameters.api.ts` — new fields and the `refresh` option.
