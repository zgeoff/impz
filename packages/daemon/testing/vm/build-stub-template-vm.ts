import { mkdir, writeFile } from 'node:fs/promises';
import type { DiskBudget } from '../../src/vm/storage/disk-budget';
import type { TemplateBuildPlan } from '../../src/vm/vmm/template-vm';

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
