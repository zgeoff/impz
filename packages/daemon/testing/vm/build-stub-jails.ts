import { existsSync } from 'node:fs';
import type { Jails } from '../../src/vm/vmm/jail';

interface StubJailsOptions {
  readonly argv?: readonly string[];

  readonly onNote?: (note: string) => void;
}

export function buildStubJails(options: Readonly<StubJailsOptions> = {}) {
  const notes: string[] = [];
  const plans: unknown[] = [];
  const refusals: { prepare: Error | null; seal: Error | null } = { prepare: null, seal: null };

  const writeNote = (note: string): void => {
    notes.push(note);
    options.onNote?.(note);
  };

  const readArgv = (): Promise<readonly string[]> => {
    if (refusals.prepare !== null) {
      return Promise.reject(refusals.prepare);
    }

    return options.argv === undefined
      ? Promise.reject(new Error('no jail command given'))
      : Promise.resolve(options.argv);
  };

  const jails: Jails = {
    prepare: (plan) => {
      plans.push(plan);

      writeNote(
        `prepare ${plan.impId} late=${String(plan.isDiskLate === true)} disk=${String(existsSync(plan.paths.disk))}`,
      );

      return readArgv();
    },
    prepareBuild: (plan) => {
      plans.push(plan);

      writeNote(`prepare build ${plan.id}`);

      return readArgv();
    },
    setupDiskOwner: (paths) => {
      writeNote(`own disk=${String(existsSync(paths.disk))}`);
    },
    release: (id) => {
      writeNote(`release ${id}`);

      return Promise.resolve();
    },
    sweepRunDir: (paths) => {
      writeNote(`sweep ${paths.impId}`);

      return Promise.resolve();
    },
    remove: (id) => {
      writeNote(`remove ${id}`);

      return Promise.resolve();
    },
    removeOrphans: () => Promise.resolve([]),
    seal: () => {
      writeNote('seal');

      if (refusals.seal !== null) {
        throw refusals.seal;
      }
    },
    removeUffdDevice: (id) => {
      writeNote(`remove uffd device ${id}`);
    },
  };

  return {
    jails,
    notes,
    plans,

    refusePrepare: (error: Error): void => {
      refusals.prepare = error;
    },

    refuseSeal: (error: Error): void => {
      refusals.seal = error;
    },
  };
}
