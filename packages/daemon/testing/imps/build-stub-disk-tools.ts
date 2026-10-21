import { onTestFinished } from 'bun:test';
import { copyFileSync } from 'node:fs';

interface DiskToolHold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

interface HoldGate {
  readonly gate: PromiseWithResolvers<void>;
  readonly reached: () => void;
}

// a plain copy ends with the same bytes an XFS reflink clone does
export function buildStubDiskTools() {
  const settings = { isCloneFailing: false, isCloneEmpty: false, isUnclean: false };
  const clones: string[] = [];
  const grows: string[] = [];
  const holds: { clone: HoldGate | null; grow: HoldGate | null } = { clone: null, grow: null };

  const waitAtHold = async (step: 'clone' | 'grow'): Promise<void> => {
    const hold = holds[step];

    if (hold !== null) {
      hold.reached();

      await hold.gate.promise;
    }
  };

  const hold = (step: 'clone' | 'grow'): DiskToolHold => {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();

    holds[step] = { gate, reached: reached.resolve };

    const held: DiskToolHold = {
      reached: reached.promise,
      release: () => {
        if (holds[step]?.gate === gate) {
          holds[step] = null;
        }

        gate.resolve();
      },
    };

    onTestFinished(() => {
      held.release();
    });

    return held;
  };

  return {
    clones,
    grows,

    cloneDisk: async (source: string, target: string): Promise<void> => {
      await waitAtHold('clone');

      if (settings.isCloneFailing) {
        throw new Error('clone failed: no space');
      }

      if (!settings.isCloneEmpty) {
        copyFileSync(source, target);
      }

      clones.push(target);
    },

    growFilesystem: async (disk: string): Promise<boolean> => {
      await waitAtHold('grow');

      grows.push(disk);

      // resize2fs never runs on a filesystem that was not unmounted cleanly
      return !settings.isUnclean;
    },

    setCloneFailing: (isFailing: boolean) => {
      settings.isCloneFailing = isFailing;
    },

    setCloneEmpty: (isEmpty: boolean) => {
      settings.isCloneEmpty = isEmpty;
    },

    setUnclean: (isUnclean: boolean) => {
      settings.isUnclean = isUnclean;
    },

    holdClone: () => hold('clone'),
    holdGrow: () => hold('grow'),
  };
}
