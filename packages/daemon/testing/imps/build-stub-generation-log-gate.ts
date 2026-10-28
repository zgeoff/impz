import { createGenerationLog } from '../../src/imps/imps/session-logs/generation-log';
import type { GenerationLog } from '../../src/imps/imps/session-logs/generation-log';

type HeldOperation = 'create' | 'append' | 'removeOldestSegment';

interface GateOptions {
  readonly operation: HeldOperation;

  // counted from 1 across every log
  readonly call: number;
}

export function buildStubGenerationLogGate(options: Readonly<GateOptions>) {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const counter = { calls: 0 };

  const holdChosenCall = async (operation: HeldOperation): Promise<void> => {
    if (operation !== options.operation) {
      return;
    }

    counter.calls += 1;

    if (counter.calls === options.call) {
      reached.resolve(undefined);

      await released.promise;
    }
  };

  const createLog: typeof createGenerationLog = async (logOptions, identity) => {
    await holdChosenCall('create');

    const log = await createGenerationLog(logOptions, identity);

    const gated: GenerationLog = {
      ...log,
      append: async (data) => {
        await holdChosenCall('append');

        return log.append(data);
      },
      removeOldestSegment: async () => {
        await holdChosenCall('removeOldestSegment');

        return log.removeOldestSegment();
      },
    };

    return gated;
  };

  return {
    createLog,
    reached: reached.promise,
    release: (): void => {
      released.resolve(undefined);
    },
  };
}
