import { listImps } from '../../platform/db/imps';
import type { ResourceDelta } from '../../platform/telemetry/resource-delta';
import type { ImpHost, ImpMemory, ImpVms } from './imp-context';

export async function readRunningImpUsage(
  context: ImpHost & ImpVms & ImpMemory,
): Promise<ResourceDelta[]> {
  const imps = await listImps(context.db);

  const deltas: ResourceDelta[] = [];

  const running = new Set<string>();

  for (const imp of imps) {
    if (imp.state !== 'running' || imp.pid === null) {
      continue;
    }

    running.add(imp.id);

    const delta = context.resources.readVmUsage({
      impId: imp.id,
      pid: imp.pid,
      apiSocket: context.findPaths(imp.id).apiSocket,
      tap: context.findAddress(imp.slot).tap,
    });

    if (delta !== null) {
      deltas.push(delta);
    }
  }

  if (context.kernelOops.readOopsSeenAt() !== null) {
    context.kernelOops.readOopsOwners(context.resources.listThreadOwners);
  }

  context.resources.keepOnly(running);

  return deltas;
}

export function startCounting(
  context: ImpVms & ImpMemory,
  imp: Readonly<{ id: string; slot: number }>,
  pid: number,
): void {
  context.resources.startCounting({
    impId: imp.id,
    pid,
    apiSocket: context.findPaths(imp.id).apiSocket,
    tap: context.findAddress(imp.slot).tap,
  });
}
