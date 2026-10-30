import type { Imp, ImpChangeReason } from '@impz/api';
import { match } from 'ts-pattern';
import type { ImpClient } from '../config/create-imp-client';
import { pickCreatedName } from './pick-created-name';
import { readImp } from './read-imp';

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

  // by name, the id of each imp that this run's own create call returned; the
  // bench acts only on an imp whose id still matches, since impd acts by name
  // and another run may destroy the imp and make a new one under it
  readonly owned: Map<string, string>;

  // names that hold an imp nothing proves is the run's; the bench leaves them
  // alone and reports them
  readonly leftovers: Set<string>;
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
      await waitOwned(subject);

      return () => subject.client.imps.sleep({ name: subject.name, force: true });
    },
  },
];

// a removed name is no longer the run's, so another run may take it before
// the next create, which then fails as CONFLICT and claims nothing
async function removeImpIfPresent(subject: BenchSubject): Promise<void> {
  if (!subject.owned.has(subject.name)) {
    return;
  }

  const imp = await readImp(subject.client, subject.name);

  if (imp !== null && subject.owned.get(subject.name) === imp.id) {
    await subject.client.imps.destroy({ name: subject.name });
  } else if (imp !== null) {
    subject.leftovers.add(subject.name);
  }

  subject.owned.delete(subject.name);
}

// The run claims an imp only when its own create call returned it.
async function createImp(subject: BenchSubject): Promise<Imp> {
  try {
    const created = await subject.client.imps.create({
      name: subject.name,
      ...(subject.settings.memoryMib !== null && { memoryMib: subject.settings.memoryMib }),
      ...(subject.settings.image !== null && { image: subject.settings.image }),
    });

    subject.owned.set(subject.name, created.id);

    return created;
  } catch (error) {
    const isNameHeld = await readImp(subject.client, subject.name).then(
      (imp) => imp !== null,
      () => false,
    );

    match(pickCreatedName({ error, isNameHeld }))
      .with('leftover', () => subject.leftovers.add(subject.name))
      .with('none', () => null)
      .exhaustive();

    throw error;
  }
}

// returns whether it created the imp, which has then never woken
async function bringAwake(subject: BenchSubject): Promise<boolean> {
  const imp = await readOwnedImp(subject);

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

// impd acts by name, so the bench reads the imp before it acts and refuses one
// whose id is not the one its create returned
async function readOwnedImp(subject: BenchSubject): Promise<Imp | null> {
  const imp = await readImp(subject.client, subject.name);

  if (imp === null) {
    subject.owned.delete(subject.name);

    return null;
  }

  if (subject.owned.get(subject.name) !== imp.id) {
    subject.owned.delete(subject.name);
    subject.leftovers.add(subject.name);
    throw new Error(`${subject.name} exists, and this run did not create it`);
  }

  return imp;
}

async function sleepImp(subject: BenchSubject): Promise<void> {
  await waitOwned(subject);

  await subject.client.imps.sleep({ name: subject.name, force: true });
}

// a wait gives another run time to replace the imp, so the bench reads it again
async function waitOwned(subject: BenchSubject): Promise<void> {
  await subject.wait(subject.settings.awakeMs);

  if ((await readOwnedImp(subject)) === null) {
    throw new Error(`${subject.name} went while the bench waited`);
  }
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
