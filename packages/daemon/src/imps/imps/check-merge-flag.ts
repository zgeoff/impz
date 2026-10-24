import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { ImpHost, ImpMemory } from './imp-context';

export interface MergeFlags {
  readonly recordLost: (id: string) => void;
  readonly clearLost: (id: string) => void;
  readonly isLost: (id: string) => boolean;
}

export function createMergeFlags(): MergeFlags {
  const lost = new Set<string>();

  return {
    recordLost: (id) => {
      lost.add(id);
    },
    clearLost: (id) => {
      lost.delete(id);
    },
    isLost: (id) => lost.has(id),
  };
}

// Before Linux 6.19 (590c03ca6a3f), ksmd can clear the merge flag during the exec.
export async function checkMergeFlag(
  context: ImpHost & ImpMemory,
  imp: Readonly<{ id: string; name: string }>,
  pid: number,
): Promise<void> {
  if (context.config.ksm === null) {
    return;
  }

  const mergeable = await context.checkGuestMerge(pid);

  if (mergeable === null) {
    getImpdLogger('imps')
      .with({ imp: imp.name })
      .warning('cannot read whether KSM may merge its guest memory');

    return;
  }

  if (!mergeable) {
    context.mergeFlags.recordLost(imp.id);

    getImpdLogger('imps')
      .with({ imp: imp.name })
      .warning('KSM cannot merge its guest memory (no merge flag after the exec)');

    return;
  }

  context.mergeFlags.clearLost(imp.id);
}

export async function checkAdoptedMergeFlag(
  context: ImpHost & ImpMemory,
  imp: Readonly<{ id: string; name: string }>,
  pid: number,
): Promise<void> {
  if (context.config.ksm !== null) {
    await checkMergeFlag(context, imp, pid);

    return;
  }

  if ((await context.checkGuestMerge(pid)) === true) {
    getImpdLogger('imps')
      .with({ imp: imp.name })
      .info('its VM keeps the KSM merge flag with IMP_KSM off, until the imp restarts');
  }
}
