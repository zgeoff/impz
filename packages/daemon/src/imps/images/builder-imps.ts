import { readFile } from 'node:fs/promises';
import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StartTimer } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { startRealTimer } from '../../platform/process/start-real-timer';
import type { ImpsConfig } from '../imps-config';
import type { ImpService } from '../imps/imp-service';
import { createGuestExec } from './guest-exec';
import type { GuestExec } from './guest-exec';

export const BUILDER_IMAGE = 'imp-builder';
const ENGINE_READY_MS = 60_000;
const ENGINE_POLL_MS = 500;
const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const REMOVE_RETRY_MS = 30_000;

export interface Builders {
  readonly withBuilder: <T>(
    signal: AbortSignal,
    run: (exec: GuestExec, name: string) => Promise<T>,
  ) => Promise<T>;

  readonly removeLeftovers: () => Promise<void>;
}

export interface BuilderTestRegistry {
  readonly name: string;
  readonly address: string;
  readonly port: number;

  // Read for each builder, so the registry's certificate may change while impd runs.
  readonly caPath: string;
}

export interface BuildersDeps {
  readonly config: Pick<ImpsConfig, 'build'>;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpService, 'createImp' | 'destroyImpId' | 'openBuilderExec'>;

  readonly ensureImage: (signal: AbortSignal) => Promise<void>;
  readonly log: (message: string) => void;

  readonly testRegistry?: BuilderTestRegistry | null;

  readonly startTimer?: StartTimer;

  readonly engineClock?: EngineClock;
}

function pickBuilderName(): string {
  const picks = Array.from({ length: 8 }, () => Math.random() * NAME_ALPHABET.length);

  return `imp-build-${picks.map((pick) => NAME_ALPHABET[Math.floor(pick)]).join('')}`;
}

interface EngineClock {
  readonly now: () => number;
  readonly wait: (durationMs: number) => Promise<void>;
}

async function waitForEngine(
  exec: GuestExec,
  signal: AbortSignal,
  clock: Readonly<EngineClock>,
): Promise<void> {
  const deadline = clock.now() + ENGINE_READY_MS;

  for (;;) {
    const info = await exec(['docker', 'info', '--format', '{{.ServerVersion}}'], {
      signal,
      timeoutMs: ENGINE_READY_MS,
    });

    if (info.exitCode === 0) {
      return;
    }

    if (clock.now() > deadline) {
      throw new Error(
        `the builder's engine did not answer in ${String(ENGINE_READY_MS / 1000)} s: ${info.stderr.trim()}`,
      );
    }

    await clock.wait(ENGINE_POLL_MS);
  }
}

// The engine reads certs.d on each pull, so the CA needs no engine restart.
const WRITE_TEST_REGISTRY = [
  'set -e',
  'mkdir -p "/etc/docker/certs.d/$1:$2"',
  'printf "%s" "$3" > "/etc/docker/certs.d/$1:$2/ca.crt"',
  String.raw`printf "%s %s\n" "$4" "$1" >> /etc/hosts`,
].join('\n');

async function writeTestRegistry(
  exec: GuestExec,
  registry: Readonly<BuilderTestRegistry>,
  signal: AbortSignal,
): Promise<void> {
  const ca = await readFile(registry.caPath, 'utf8');

  const written = await exec(
    [
      'sh',
      '-c',
      WRITE_TEST_REGISTRY,
      'sh',
      registry.name,
      String(registry.port),
      ca,
      registry.address,
    ],
    { signal },
  );

  if (written.exitCode !== 0) {
    throw new Error(
      `writing the test registry ${registry.name} into the builder: ${written.stderr.trim()}`,
    );
  }
}

export function createBuilders(deps: BuildersDeps): Builders {
  const startTimer: StartTimer =
    deps.startTimer ?? ((fire, durationMs) => startRealTimer(fire, durationMs, { isUnref: true }));

  const engineClock = deps.engineClock ?? { now: Date.now, wait: Bun.sleep };

  const retrying = new Set<string>();

  const removeOnce = async (id: string, name: string): Promise<boolean> => {
    try {
      await deps.imps.destroyImpId(id, 'builder');

      return true;
    } catch (error) {
      deps.log(
        `impd: image build: ERROR: builder ${name} survives its removal, tried again every ${String(REMOVE_RETRY_MS / 1000)} s: ${getErrorMessage(error)}`,
      );

      return false;
    }
  };

  const removeLater = (id: string, name: string): void => {
    if (retrying.has(id)) {
      return;
    }

    retrying.add(id);

    const tryAgain = async () => {
      const gone = await removeOnce(id, name);

      if (gone) {
        retrying.delete(id);
        deps.log(`impd: image build: removed builder ${name}`);

        return;
      }

      startTimer(() => void tryAgain(), REMOVE_RETRY_MS);
    };

    startTimer(() => void tryAgain(), REMOVE_RETRY_MS);
  };

  const removeBuilder = async (id: string, name: string): Promise<void> => {
    const gone = await removeOnce(id, name);

    if (!gone) {
      removeLater(id, name);
    }
  };

  return {
    withBuilder: async (signal, run) => {
      await deps.ensureImage(signal);

      signal.throwIfAborted();

      const id = Bun.randomUUIDv7();
      const name = pickBuilderName();
      const started = performance.now();

      try {
        await deps.imps.createImp({
          id,
          name,
          image: BUILDER_IMAGE,
          memoryMib: deps.config.build.memoryMib,
          diskMib: Math.ceil(deps.config.build.diskBytes / 1024 ** 2),
          policy: { mode: 'public', allow: [] },
          kind: 'builder',
        });

        const exec = createGuestExec((request) => deps.imps.openBuilderExec(name, request));

        await waitForEngine(exec, signal, engineClock);

        if (deps.testRegistry !== undefined && deps.testRegistry !== null) {
          await writeTestRegistry(exec, deps.testRegistry, signal);
        }

        const readyMs = Math.round(performance.now() - started);

        deps.log(`impd: image build: builder ${name} ready in ${String(readyMs)}ms`);

        return await run(exec, name);
      } finally {
        await removeBuilder(id, name);
      }
    },
    removeLeftovers: async () => {
      const imps = await listImps(deps.db);

      for (const imp of imps.filter((each) => each.kind === 'builder')) {
        deps.log(`impd: removing builder ${imp.name}, which a stopped impd left`);

        await removeBuilder(imp.id, imp.name);
      }
    },
  };
}
