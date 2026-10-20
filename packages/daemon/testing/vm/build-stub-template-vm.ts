import { mkdir, writeFile } from 'node:fs/promises';
import type { DiskBudget } from '../../src/storage/disk-budget';
import type { TemplateBuildPlan } from '../../src/vmm/template-vm';

// The VMM's createTemplateVm: it records each plan and the disk room the
// budget held while it ran, then writes the snapshot's two files where the
// plan names them, as a paused guest's snapshot lands.
export function buildStubTemplateVm(diskBudget: Pick<DiskBudget, 'readStatus'>) {
  const builds: TemplateBuildPlan[] = [];
  const pendingAtBuild: number[] = [];

  const createVm = async (plan: Readonly<TemplateBuildPlan>): Promise<void> => {
    builds.push(plan);

    const status = await diskBudget.readStatus();

    pendingAtBuild.push(status.pendingBytes);

    await mkdir(plan.snapshotDir, { recursive: true });
    await writeFile(plan.vmstate, 'vmstate');
    await writeFile(plan.memFile, 'mem');
  };

  return { buildVm: createVm, builds, pendingAtBuild };
}
