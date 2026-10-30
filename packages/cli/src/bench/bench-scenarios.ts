import type { Imp, ImpChangeReason } from '@impz/api';
import { ORPCError } from '@impz/client';
import { match } from 'ts-pattern';
import type { ImpClient } from '../config/create-imp-client';

export interface BenchSettings {
  readonly memoryMib: number | null;
  readonly image: string | null;
  readonly awakeMs: number;
}

interface BenchSubject {
  readonly client: ImpClient;
  readonly name: string;
  readonly settings: BenchSettings;
  readonly wait: (durationMs: number) => Promise<void>;

  // the names this run created, the only imps the bench may remove
  readonly owned: Set<string>;
}

// A scenario returns its timed step, so the bench times nothing the arrange
// did, and the step resolves to the imp its call returned, which names the
// change event it caused. `impz bench <name>` runs a scenario on this list.
type BenchStep = () => Promise<Imp>;

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
      const isNew = await bringAwake(subject);

      if (isNew) {
        await sleepImp(subject);

        await subject.client.imps.wake({ name: subject.name });
      }

      await sleepImp(subject);

      return () => subject.client.imps.wake({ name: subject.name });
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

      return () => subject.client.imps.wake({ name: subject.name });
    },
  },
  {
    name: 'restore',
    description: 'restore an awake imp to a checkpoint',
    reason: 'restored',
    arrange: async (subject) => {
      await bringAwake(subject);

      const checkpoint = await ensureBenchCheckpoint(subject);

      return () => subject.client.checkpoints.restore({ name: subject.name, checkpoint });
    },
  },
  {
    name: 'sleep',
    description: 'put an awake imp to sleep',
    reason: 'slept',
    arrange: async (subject) => {
      await bringAwake(subject);

      await subject.wait(subject.settings.awakeMs);

      return () => subject.client.imps.sleep({ name: subject.name, force: true });
    },
  },
];

async function removeImpIfPresent(subject: BenchSubject): Promise<void> {
  if (subject.owned.has(subject.name) && (await readImp(subject)) !== null) {
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

// A create that fails after impd made the imp, such as a boot that fails,
// leaves an imp the run owns; a refused name belongs to someone else.
async function createImp(subject: BenchSubject): Promise<Imp> {
  try {
    const created = await subject.client.imps.create({
      name: subject.name,
      ...(subject.settings.memoryMib !== null && { memoryMib: subject.settings.memoryMib }),
      ...(subject.settings.image !== null && { image: subject.settings.image }),
    });

    subject.owned.add(subject.name);

    return created;
  } catch (error) {
    if (!(error instanceof ORPCError && error.code === 'CONFLICT')) {
      subject.owned.add(subject.name);
    }

    throw error;
  }
}

// returns whether it created the imp, which has then never woken
async function bringAwake(subject: BenchSubject): Promise<boolean> {
  const imp = await readImp(subject);

  if (imp === null) {
    await createImp(subject);

    return true;
  }

  await match(imp.state)
    .with('running', () => Promise.resolve())
    .with('sleeping', () => subject.client.imps.wake({ name: subject.name }))
    .with('stopped', () => subject.client.imps.start({ name: subject.name }))
    .with('creating', 'error', (state) => {
      throw new Error(`${subject.name} is ${state}`);
    })
    .exhaustive();

  return false;
}

async function sleepImp(subject: BenchSubject): Promise<void> {
  await subject.wait(subject.settings.awakeMs);
  await subject.client.imps.sleep({ name: subject.name, force: true });
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
