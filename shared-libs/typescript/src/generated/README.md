# Generated Protobuf Types

This directory is populated by running:

```bash
cd shared-libs/typescript
npm run proto:generate
```

The `proto:generate` script invokes `buf generate` using `proto/buf.gen.yaml`,
which runs `ts-proto` against the `.proto` files in `proto/ubrnms/`.

**Do not hand-edit files in this directory** — they are overwritten on every generation run.

## Files produced (after running the generator)

- `device.ts` — `DeviceEntity`, `DeviceType`, `DeviceStatus`, `DeviceTag` (from `proto/ubrnms/device.proto`)
- `alarm.ts`  — `AlarmRecord`, `AlarmSeverity`, `AlarmState` (from `proto/ubrnms/alarm.proto`)
- `kpi.ts`    — `KPIDataPoint`, `KpiGranularity` (from `proto/ubrnms/kpi.proto`)
- `events.ts` — Kafka event envelope types (from `proto/ubrnms/events.proto`)

## Replacing hand-written models

Once generation has run, replace imports of `@ubr-nms/shared-models` with:

```typescript
// Before (hand-written)
import type { DeviceEntity } from '@ubr-nms/shared-models';

// After (proto-generated)
import type { DeviceEntity } from '@ubr-nms/shared-models/generated';
```

See `src/proto-adapter.ts` for conversion helpers during the transition period.
