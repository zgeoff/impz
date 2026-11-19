import type { CpuCgroups } from '../../vm/vmm/cpu-cgroups';

export const OOM_KILL_TRIGGER = 'its memory limit killed firecracker';

// A cgroup that a busy rmdir kept still counts an older kill, so a count alone
// does not show a kill since this call.
export function startOomWatch(
  cgroups: Pick<CpuCgroups, 'readOomKills'>,
  impId: string,
): () => boolean {
  const before = cgroups.readOomKills(impId) ?? 0;

  return () => (cgroups.readOomKills(impId) ?? 0) > before;
}
