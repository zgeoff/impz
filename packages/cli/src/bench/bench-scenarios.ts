import type { Imp, ImpChangeReason } from '@impz/api';
import { ORPCError } from '@impz/client';
import { match } from 'ts-pattern';
import type { ImpClient } from '../config/create-imp-client';

export interface BenchSettings {
  readonly memoryMib: number | null;
  readonly image: string | null;
  readonly awakeMs: number;
}

export interface BenchSubject {
  readonly client: ImpClient;
  readonly name: string;
  readonly settings: BenchSettings;
  readonly wait: (durationMs: number) => Promise<void>;
}

// A scenario brings one imp to where its timed step starts and returns that
// step, so the bench times nothing the arrange already did. A new scenario
// joins the list, and `impz bench <name>` runs it.
type BenchStep = () => Promise<void>;

export interface BenchScenario {
  readonly name: string;
  readonly description: string;
  readonly reason: ImpChangeReason;
  readonly arrange: (subject: BenchSubject) => Promise<BenchStep>;
}

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  {
    name: 'create',
    description: 'create an imp and boot it',
    reason: 'booted',
    arrange: async (subject) => {
      await removeImpIfPresent(subject);

      return () => createImp(subject);
    },
  },
  {
    name: 'wake',
    description: 'wake an imp that went to sleep after it woke',
    reason: 'woke',
    arrange: async (subject) => {
      await bringAwake(subject);
      await sleepImp(subject);

      return () => wakeImp(subject);
    },
  },
  {
    name: 'wake-young',
    description: 'wake an imp that went to sleep right after a cold boot',
    reason: 'woke',
    arrange: async (subject) => {
      await bringAwake(subject);

      await subject.client.imps.stop({ name: subject.name, force: true });
      await subject.client.imps.start({ name: subject.name });

      await sleepImp(subject);

      return () => wakeImp(subject);
    },
  },
  {
    name: 'restore',
    description: 'restore an awake imp to a checkpoint',
    reason: 'restored',
    arrange: async (subject) => {
      await bringAwake(subject);

      const checkpoint = await ensureBenchCheckpoint(subject);

      return async () => {
        await subject.client.checkpoints.restore({ name: subject.name, checkpoint });
      };
    },
  },
  {
    name: 'sleep',
    description: 'put an awake imp to sleep',
    reason: 'slept',
    arrange: async (subject) => {
      await bringAwake(subject);

      await subject.wait(subject.settings.awakeMs);

      return async () => {
        await subject.client.imps.sleep({ name: subject.name, force: true });
      };
    },
  },
];

async function removeImpIfPresent(subject: BenchSubject): Promise<void> {
  if ((await readImp(subject)) !== null) {
    await subject.client.imps.destroy({ name: subject.name });
  }
}

async function readImp(subject: BenchSubject): Promise<Imp | null> {
  try {
    return await subject.client.imps.get({ name: subject.name });
  } catch (error) {
    if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
      return null;
    }

    throw error;
  }
}

async function createImp(subject: BenchSubject): Promise<void> {
  await subject.client.imps.create({
    name: subject.name,
    ...(subject.settings.memoryMib !== null && { memoryMib: subject.settings.memoryMib }),
    ...(subject.settings.image !== null && { image: subject.settings.image }),
  });
}

async function bringAwake(subject: BenchSubject): Promise<void> {
  const imp = await readImp(subject);

  if (imp === null) {
    await createImp(subject);

    return;
  }

  await match(imp.state)
    .with('running', () => Promise.resolve())
    .with('sleeping', () => subject.client.imps.wake({ name: subject.name }))
    .with('stopped', () => subject.client.imps.start({ name: subject.name }))
    .with('creating', 'error', (state) => {
      throw new Error(`${subject.name} is ${state}`);
    })
    .exhaustive();
}

async function sleepImp(subject: BenchSubject): Promise<void> {
  await subject.wait(subject.settings.awakeMs);
  await subject.client.imps.sleep({ name: subject.name, force: true });
}

async function wakeImp(subject: BenchSubject): Promise<void> {
  await subject.client.imps.wake({ name: subject.name });
}

const CHECKPOINT_LABEL = 'bench';

async function ensureBenchCheckpoint(subject: BenchSubject): Promise<string> {
  const checkpoints = await subject.client.checkpoints.list({ name: subject.name });

  const found = checkpoints.find((checkpoint) => checkpoint.label === CHECKPOINT_LABEL);

  if (found !== undefined) {
    return found.id;
  }

  const made = await subject.client.checkpoints.create({
    name: subject.name,
    label: CHECKPOINT_LABEL,
  });

  return made.id;
}
