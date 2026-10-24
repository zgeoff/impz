import { listImps } from '../../../platform/db/imps';
import type { ImpDatabase } from '../../../platform/db/open-database';
import type { Clock, StartTimer } from '../../../platform/process/clock';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { REAL_CLOCK } from '../../../platform/process/real-clock';
import { startRealTimer } from '../../../platform/process/start-real-timer';
import type { ImpsConfig } from '../../imps-config';
import type { ImpService } from '../../imps/imp-service';
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

  // Called for each builder, so the registry's certificate may change while impd runs.
  readonly readCA: () => Promise<string>;
}

export interface BuildersDeps {
  readonly config: Pick<ImpsConfig, 'build'>;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpService, 'createImp' | 'destroyImpId' | 'openBuilderExec'>;

  readonly ensureImage: (signal: AbortSignal) => Promise<void>;

  readonly testRegistry?: BuilderTestRegistry | null;

  readonly startTimer?: StartTimer;

  readonly clock?: Pick<Clock, 'now' | 'sleep'>;

  readonly pickBuilderName?: () => string;
}

function pickRandomBuilderName(): string {
  const picks = crypto.getRandomValues(new Uint8Array(8));

  return `imp-build-${[...picks].map((pick) => NAME_ALPHABET[pick % NAME_ALPHABET.length]).join('')}`;
}

async function waitForEngine(
  exec: GuestExec,
  signal: AbortSignal,
  clock: Pick<Clock, 'now' | 'sleep'>,
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
      const log = await readEngineLog(exec, signal);

      throw new Error(
        `the builder's engine did not answer in ${String(ENGINE_READY_MS / 1000)} s: ${info.stderr.trim()}${log}`,
      );
    }

    await clock.sleep(ENGINE_POLL_MS);
  }
}

// imp-agent writes each services.d service's output to /var/log/imp/<service>.log.
const ENGINE_LOG_PATH = '/var/log/imp/docker.log';
const ENGINE_LOG_LINES = 20;

async function readEngineLog(exec: GuestExec, signal: AbortSignal): Promise<string> {
  const tail = await exec(['tail', '-n', String(ENGINE_LOG_LINES), ENGINE_LOG_PATH], { signal });

  const lines = tail.stdout.trim();

  if (tail.exitCode !== 0 || lines === '') {
    return '';
  }

  return `\nthe last lines of ${ENGINE_LOG_PATH}:\n${lines}`;
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
  const ca = await registry.readCA();

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

  const clock = deps.clock ?? REAL_CLOCK;
  const pickBuilderName = deps.pickBuilderName ?? pickRandomBuilderName;
  const logger = getImpdLogger('image');

  const retrying = new Set<string>();

  const removeOnce = async (id: string, name: string): Promise<boolean> => {
    try {
      await deps.imps.destroyImpId(id, 'builder');

      return true;
    } catch (error) {
      logger.error(
        'image build: builder {name} survives its removal, tried again every {retryS} s: {error}',
        { name, retryS: REMOVE_RETRY_MS / 1000, error: getErrorMessage(error) },
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
        logger.info('image build: removed builder {name}', { name });

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
      const started = clock.now();

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

        await waitForEngine(exec, signal, clock);

        if (deps.testRegistry !== undefined && deps.testRegistry !== null) {
          await writeTestRegistry(exec, deps.testRegistry, signal);
        }

        const readyMs = Math.round(clock.now() - started);

        logger.info('image build: builder {name} ready in {readyMs}ms', { name, readyMs });

        return await run(exec, name);
      } finally {
        await removeBuilder(id, name);
      }
    },
    removeLeftovers: async () => {
      const imps = await listImps(deps.db);

      for (const imp of imps.filter((each) => each.kind === 'builder')) {
        logger.info('removing builder {name}, which a stopped impd left', { name: imp.name });

        await removeBuilder(imp.id, imp.name);
      }
    },
  };
}
