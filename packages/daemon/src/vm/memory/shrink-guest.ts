import { getSpareTotalMib, toWholeBlocks } from '../vmm/elastic-memory';
import type { GuestMemory, VmRunner } from '../vmm/vm-runner';

const POLL_MS = 100;
const STALL_MS = 500;

type GuestMemoryVm = Pick<VmRunner, 'readGuestMemory' | 'requestPluggedMib'>;

interface ShrinkOptions {
  readonly timeLimitMs: number;
  readonly sleep?: (durationMs: number) => Promise<void>;
  readonly now?: () => number;
}

export function getShrinkTargetMib(memory: Readonly<GuestMemory>): number {
  const usedMib = memory.totalMib - memory.availableMib;
  const baseMib = memory.totalMib - memory.pluggedMib;

  return Math.max(0, toWholeBlocks(getSpareTotalMib(usedMib) - baseMib));
}

export interface ShrinkResult {
  readonly before: Readonly<GuestMemory>;
  readonly reachedMib: number;
  readonly pluggedMib: number;
}

export async function shrinkGuest(
  vm: GuestMemoryVm,
  paths: Parameters<GuestMemoryVm['readGuestMemory']>[0],
  options: Readonly<ShrinkOptions>,
): Promise<ShrinkResult> {
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeLimitMs;

  const before = await vm.readGuestMemory(paths);

  const targetMib = getShrinkTargetMib(before);

  if (targetMib >= before.pluggedMib) {
    return {
      before,
      reachedMib: before.pluggedMib,
      pluggedMib: Math.max(before.pluggedMib, before.requestedMib),
    };
  }

  await vm.requestPluggedMib(paths, targetMib);

  const moved = { pluggedMib: before.pluggedMib, at: now() };
  const reached = { mib: before.pluggedMib };

  for (;;) {
    await sleep(POLL_MS);

    const seen = await vm.readGuestMemory(paths);

    reached.mib = Math.max(reached.mib, seen.pluggedMib);

    if (seen.pluggedMib <= targetMib) {
      return { before, reachedMib: reached.mib, pluggedMib: seen.pluggedMib };
    }

    if (seen.pluggedMib !== moved.pluggedMib) {
      moved.pluggedMib = seen.pluggedMib;
      moved.at = now();
    }

    if (now() - moved.at >= STALL_MS || now() >= deadline) {
      await vm.requestPluggedMib(paths, seen.pluggedMib);

      return { before, reachedMib: reached.mib, pluggedMib: seen.pluggedMib };
    }
  }
}
