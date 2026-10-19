import { PublicAuthSchema } from '@impz/api';
import type { PublicAuth } from '@impz/api';
import type { Selectable } from 'kysely';
import type { ImpRecord } from './imps';
import type { DB } from './schema';

type ImpRow = Selectable<DB['imps']>;

export function toImpRecord(row: Readonly<ImpRow>): ImpRecord {
  return {
    id: row.id,
    name: row.name,
    imageId: row.image_id,
    state: row.state,
    kind: row.kind,
    vcpus: row.vcpus,
    memoryMib: row.memory_mib,
    maxMemoryMib: row.max_memory_mib ?? row.memory_mib,
    slot: row.slot,
    ip: row.ip,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
    sleptAt: toDate(row.slept_at),
    holdUntil: toDate(row.hold_until),
    error: row.error,
    hasOopsHold: row.oops_hold === 1,
    oopsBootId: row.oops_boot_id,
    pid: row.pid,
    firecrackerVersion: row.firecracker_version,
    httpPort: row.http_port,
    diskBytes: row.disk_bytes,
    isDiskGrowPending: row.disk_grow_pending === 1,
    cpu: { limit: row.cpu_limit, weight: row.cpu_weight },
    wakeCount: row.wake_count,
    awakeMs: row.awake_ms,
    awakeSince: toDate(row.awake_since),
    isIdentityResetPending: row.identity_reset_pending === 1,
    isTrustPending: row.trust_pending === 1,
    isBackedUp: row.backup !== 0,
    publicAuth: readPublicAuth(row),
    moveState: row.move_state,
    jailUid: row.jail_uid,
  };
}

// a value impd did not write reads as tailnet-only: closed, never open
function readPublicAuth(row: Readonly<ImpRow>): PublicAuth | null {
  const auth = PublicAuthSchema.safeParse(row.public_auth);

  return row.exposure === 'public' && auth.success ? auth.data : null;
}

function toDate(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}
