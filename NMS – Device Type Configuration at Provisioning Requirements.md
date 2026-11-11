# NMS – Device Type Configuration at Provisioning: Requirements

Nov 10, 2026 · @Gayathri Kanchinadham
Last updated: Nov 10, 2026 · Implementation alignment review added

---

## 1. Overview

The client wants the device type to be set while a device is being provisioned, not fixed in advance. A device type is a combination (such as model and role), each combination can have its own configuration, and the node view for a device follows its device type in both directions.

**Client input, as given**

- During provisioning: device type configurable
- Configuration → device type: multiple combinations
- Status update
- Device role drop-down
- Node view ↔ device type bidirectional sync
- Model-specific, role-based

**Scope:** device type selection and configuration during provisioning, the role drop-down, model- and role-specific configuration, status updates, and keeping node views and device types in sync. MIB parsing and the screen builder are covered in the earlier requirement docs.

---

## 2. Functional requirements

| ID | Requirement | Acceptance criteria | Implementation status |
| --- | --- | --- | --- |
| DT-01 | The device type can be set and changed during provisioning. | Provisioning form has a device type field; the type is not locked in before provisioning starts. | ✅ **Partial** — SNMP auto-detects type; admin can override via chip selector in provision modal. Model+role picker is missing. |
| DT-02 | A device type is a combination of attributes (at least model and role), and many combinations can exist. | Admin can create, edit and list combinations; each one is unique. | ❌ **Not built** — `deviceType` is a flat string. No combination entity, no admin CRUD screen. |
| DT-03 | Each configuration is linked to one or more device type combinations. | Picking a combination at provisioning loads its configuration. | ⚠️ **Partial** — Product Definition → device type linkage exists, but not via model+role combinations. |
| DT-04 | Device role is chosen from a drop-down. | Drop-down lists only the roles defined for the selected model. | ❌ **Not built** — `deviceRole` is SNMP auto-detected and shown as read-only. No manual dropdown, no model→roles mapping. |
| DT-05 | Configuration is model-specific. | Only parameters the model supports are shown and applied. | ⚠️ **Partial** — Selecting a Product Definition template restricts discovery to matching devices. Not surfaced as a first-class filter in the provisioning form. |
| DT-06 | Configuration is role-based. | Parameter groups and fields shown depend on the selected role. | ❌ **Not built** — Node View shows all OID groups regardless of role. No role-based group filtering. |
| DT-07 | The node view and the device type stay in sync in both directions (Section 4). | A change on either side shows on the other without manual steps. | ❌ **Not built** — Node view is linked to `productDefinitionId` (one-way). Changing device type does not switch the node view. No orphan detection, no conflict resolution. |
| DT-08 | Provisioning shows status updates for each device (Section 5). | Status changes are visible in the device list and device details, with time and reason. | ⚠️ **Partial** — `PROVISIONING`, `ONLINE`, `OFFLINE`, `DEPROVISIONED` exist. `Discovered`, `Type assigned`, `Re-provisioning` statuses are missing. No time + reason recorded per transition. |
| DT-09 | Changing the device type of a provisioned device re-applies the matching configuration and node view. | Admin is shown what will change and confirms before it is applied. | ❌ **Not built** — Editing device type in inventory calls PUT with the new type only. No config re-application, no confirmation diff, no node view update. |
| DT-10 | Every device type change is logged. | Log shows old and new type, who changed it and when. | ❌ **Not built** — No audit log exists in the database or the UI. |

**Coverage summary:** 2 requirements partially met (~40% each), 2 partially met (~50% each), 5 not built, 1 partial at ~80%.

---

## 3. Device type combinations

A device type is the combination of a model and a role, so one model can be provisioned in different roles, each with its own configuration and node view. The table shows the structure with placeholder values; real models and roles come from the client.

| Model | Role | Configuration | Node view |
| --- | --- | --- | --- |
| \[Model A\] | \[Role 1, e.g., BTS\] | Config A-1 | Node view A-1 |
| \[Model A\] | \[Role 2, e.g., CPE\] | Config A-2 | Node view A-2 |
| \[Model B\] | \[Role 1, e.g., BTS\] | Config B-1 | Node view B-1 |

**Rules**

- Each model has a list of roles it supports; the role drop-down shows only those.
- One configuration can serve more than one combination when they share the same parameters.
- A combination can't be provisioned until it has a configuration and a node view.

**Current implementation gap:** The system uses a flat `deviceType` string (e.g. `"SWITCH"`, `"RADIO"`, `"BTS"`). There is no `DeviceTypeCombination` entity, no admin screen to manage combinations, and the provision modal does not offer a model-first then role-filtered flow. Building DT-02 and DT-04 is a prerequisite for all other items in this section.

---

## 4. Node view ↔ device type sync

The node view and the device type always point at each other, so a change made on either side is applied to the other.

| Change made | What happens automatically | Current implementation status |
| --- | --- | --- |
| Device type set or changed on a device | The device switches to the node view linked to the new model + role. | ❌ Not implemented — type change has no effect on node view |
| Node view edited (fields, groups, layout) | Every device of the linked device type shows the updated view. | ⚠️ Partial — node view updates for devices sharing the same `productDefinitionId`, but not by model+role |
| Node view re-linked to another device type | Devices of the old type lose it, devices of the new type get it; the admin is warned first. | ❌ Not implemented — no warning, no cascade |
| Device type's configuration changed (parameters added or removed) | The linked node view shows the new parameters as unplaced and flags removed ones. | ❌ Not implemented |
| Role or model removed from a device type | Its node view is marked as orphaned and can't be applied until re-linked. | ❌ Not implemented — no orphan concept |

**Rules**

- One device type combination has one active node view at a time.
- Sync never overwrites the admin's layout or labels; new items are added, removed items are flagged.
- Conflicts (both sides changed at once) are shown to the admin to resolve, not settled silently.

---

## 5. Status updates

Each device shows where it is in provisioning, and the status updates on its own as provisioning moves along. Proposed statuses, to be confirmed with the client:

| Status | Meaning | In system today? |
| --- | --- | --- |
| Discovered | Device found; device type not yet set. | ❌ No — discovery results live in a run object, not in inventory |
| Type assigned | Model and role chosen; configuration and node view linked. | ❌ No |
| Provisioning | Configuration being pushed to the device. | ✅ Yes — `PROVISIONING` status exists |
| Provisioned | Configuration applied; device shown with its node view. | ✅ Yes — mapped to `ONLINE` status |
| Failed | Provisioning stopped; reason shown (e.g., unsupported parameter, device unreachable). | ⚠️ Partial — error shown in modal; no persistent `FAILED` status record |
| Re-provisioning | Device type or configuration changed; new configuration being applied. | ❌ No |

Every status change records the time, the user or system that caused it, and a reason where there is one.

**Current implementation gap:** Status transitions do not store timestamps or reasons. Only the latest status is kept. The `Discovered` and `Type assigned` states do not exist in the inventory data model.

---

## 6. Implementation gaps — build priority

The following gaps must be addressed in order, as later items depend on earlier ones.

| Priority | Gap | Depends on |
| --- | --- | --- |
| 1 | **DT-02** — `DeviceTypeCombination` entity (model + role + config + node view), backend CRUD, admin screen | — |
| 2 | **DT-04** — Role dropdown in provision modal, filtered by selected model | DT-02 |
| 3 | **DT-07** — Node view lookup by model+role combination instead of `productDefinitionId` alone; type-change cascade | DT-02 |
| 4 | **DT-08** — Add `Discovered`, `Type assigned`, `Re-provisioning` to status enum; store timestamp + reason per transition | — |
| 5 | **DT-09** — Re-apply config + node view on device type edit, with confirmation diff dialog | DT-02, DT-07 |
| 6 | **DT-10** — `deviceTypeChangeLog` collection; audit entry on every type write | — |
| 7 | **DT-06** — Role-based OID group filtering in Node View | DT-02, DT-04 |

---

## 7. Open questions for the client

- [ ] Besides model and role, what makes up a device type combination (vendor, firmware version, hardware revision)?
- [ ] Full list of device roles for the drop-down (e.g., BTS, CPE, Radio), and which roles each model supports.
- [ ] Should the device type be detected automatically during discovery and only confirmed by the admin, or always picked by hand? *(Current system auto-detects via SNMP OID and allows override — confirm this is acceptable.)*
- [ ] Does "status update" mean the provisioning status above, a status pushed to the device, or both?
- [ ] For bidirectional sync: should node view edits apply to devices at once, or only after Validate → Approve → Activate?
- [ ] Earlier we agreed all devices from one MIB get one node view. With model- and role-specific views, one MIB can now have several node views. Please confirm.
- [ ] The current system stores `deviceType` as a flat string. Migrating to model+role combinations will require a data migration for all existing provisioned devices. Is a migration window available, or should the new model run in parallel with the old one?
