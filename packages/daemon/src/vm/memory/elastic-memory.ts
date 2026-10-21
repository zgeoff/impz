// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';

// Movable memory cannot hold the kernel's own allocations, so a guest that is mostly hot-plugged
// memory runs out of kernel memory first.
const MAX_GROWTH_FACTOR = 4;

// Firecracker's virtio-mem device sizes its region in whole slots, and plugs or unplugs whole blocks.
export const SLOT_MIB = 128;
export const BLOCK_MIB = 2;

// The kernel onlines hot-plugged memory as movable with this argument, so an unplug can migrate
// pages away.
export const ONLINE_MOVABLE_ARG = 'memhp_default_state=online_movable';
export const GROW_STEP_MIB = 256;

// The balloon statistics lag up to 1 s and a tick is 500 ms, so this margin covers a burst of about
// 100 MiB/s.
const LOW_FLOOR_MIB = 128;
const LOW_FRACTION = 0.15;

// The guest kernel pays 64 bytes of base memory per 4 KiB page of plugged memory. Measured, 3 GiB
// plugged cost 48 MiB, and an unplugged region nothing.
const STRUCT_PAGE_MIB_PER_GIB = 16;

export function getRegionMib(memoryMib: number, maxMemoryMib: number): number {
  const growth = maxMemoryMib - memoryMib;

  return growth <= 0 ? 0 : Math.ceil(growth / SLOT_MIB) * SLOT_MIB;
}

export function getLowMib(totalMib: number): number {
  return Math.max(LOW_FLOOR_MIB, totalMib * LOW_FRACTION);
}

export function getSpareTotalMib(usedMib: number): number {
  return Math.max(
    usedMib + LOW_FLOOR_MIB + GROW_STEP_MIB,
    Math.ceil((usedMib + GROW_STEP_MIB) / (1 - LOW_FRACTION)),
  );
}

export function getStructPageMib(mib: number): number {
  return Math.ceil((mib * STRUCT_PAGE_MIB_PER_GIB) / 1024);
}

export function resolveMaxMemoryMib(memoryMib: number, requested: number | undefined): number {
  if (requested === undefined) {
    return memoryMib;
  }

  if (requested < memoryMib) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the max memory (${String(requested)} MiB) is less than the memory (${String(memoryMib)} MiB)`,
    });
  }

  const ceiling = memoryMib * MAX_GROWTH_FACTOR;

  if (requested > ceiling) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the max memory (${String(requested)} MiB) is more than ${String(MAX_GROWTH_FACTOR)} × the memory (${String(ceiling)} MiB): memory the guest grows into cannot hold its kernel's own allocations, so raise the memory too`,
    });
  }

  return requested;
}

export function toWholeBlocks(mib: number): number {
  return Math.ceil(mib / BLOCK_MIB) * BLOCK_MIB;
}
