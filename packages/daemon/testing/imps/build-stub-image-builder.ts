import { DOCKERFILE_FRONTEND } from '../../src/imps/docker-proxy/dockerfile-frontend';
import type { Builders } from '../../src/imps/images/builder-imps';
import { createGuestExec } from '../../src/imps/images/guest-exec';
import { PIN_INSPECT_FORMAT } from '../../src/imps/images/image-pin';
import { buildStubGuest } from '../vm/build-stub-guest';
import type { StubAnswer, StubRun } from '../vm/build-stub-guest';

type StubBuilderStep = 'pin' | 'tag' | 'config' | 'create' | 'export';

// The fields a pin inspect renders, and how the builder's engine holds the image.
export interface StubBuilderImage {
  readonly Id: string;
  readonly RepoDigests: readonly string[];
  readonly Architecture?: string;
  readonly OnBuild?: readonly string[];

  readonly isOnEngine?: boolean;
  readonly pullError?: string;
}

export interface StubBuilderFrontend {
  readonly isOnEngine: boolean;
  readonly pullError?: string;
}

export interface StubImageBuilderOptions {
  readonly exported: readonly Uint8Array[] | AsyncIterable<Uint8Array>;
  readonly repoDigest: string;
  readonly images?: Readonly<Record<string, StubBuilderImage>>;
  readonly frontend?: StubBuilderFrontend;
  readonly onPull?: (run: StubRun) => Promise<StubAnswer> | StubAnswer;
  readonly onBuild?: (run: StubRun) => Promise<StubAnswer> | StubAnswer;
  readonly onExport?: () => Promise<void>;
  readonly isExportStalled?: boolean;
  readonly config?: string;
  readonly architecture?: string;
  readonly failures?: Readonly<Partial<Record<StubBuilderStep, string>>>;
  readonly buildLog?: string;
}

const BUILT_CONFIG = '{"Cmd":["/bin/sh"],"Env":["PATH=/bin"]}';

export const STUB_BUILDER_CONTAINER = 'e'.repeat(64);

// a real builder imp's name is `imp-build-` and 8 letters
const STUB_BUILDER_NAME = 'imp-build-stubstub';

export function buildStubImageBuilder(options: Readonly<StubImageBuilderOptions>) {
  const builtDockerfiles: string[] = [];
  const builtContexts: Uint8Array[] = [];
  const counts = { boots: 0, live: 0 };

  const pulled = new Set<string>();

  const isOnEngine = (ref: string, held: boolean | undefined) => held !== false || pulled.has(ref);

  const answerPull = async (run: StubRun, ref: string): Promise<StubAnswer> => {
    const pullError =
      ref === DOCKERFILE_FRONTEND ? options.frontend?.pullError : options.images?.[ref]?.pullError;

    if (pullError !== undefined) {
      return { code: 1, stderr: `${pullError}\n` };
    }

    const answer = options.onPull === undefined ? {} : await options.onPull(run);

    if ((answer.code ?? 0) === 0) {
      pulled.add(ref);
    }

    return answer;
  };

  const answerPinInspect = (ref: string): StubAnswer => {
    if (options.images === undefined) {
      const inspect = {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`${ref.split(':')[0] ?? ''}@${options.repoDigest}`],
        Os: 'linux',
        Architecture: options.architecture ?? 'amd64',
        Config: {},
      };

      return { stdout: JSON.stringify(inspect) };
    }

    const image = options.images[ref];

    if (image === undefined || !isOnEngine(ref, image.isOnEngine)) {
      return { code: 1, stderr: `Error response from daemon: No such image: ${ref}\n` };
    }

    const inspect = {
      Id: image.Id,
      RepoDigests: image.RepoDigests,
      Os: 'linux',
      Architecture: image.Architecture ?? 'amd64',
      Config: image.OnBuild === undefined ? {} : { OnBuild: image.OnBuild },
    };

    return { stdout: JSON.stringify(inspect) };
  };

  const answerRun = (run: StubRun): Promise<StubAnswer> | StubAnswer => {
    const step = readStep(run.argv.slice(1).join(' '), run.argv.at(-1) ?? '');
    const failure = step === null ? undefined : options.failures?.[step];

    if (failure !== undefined) {
      return { code: 1, stderr: `${failure}\n` };
    }

    return answerStep(run);
  };

  const answerStep = async (run: StubRun): Promise<StubAnswer> => {
    const argv = run.argv.slice(1).join(' ');
    const ref = run.argv.at(-1) ?? '';

    if (argv.startsWith('info ')) {
      return {};
    }

    if (argv.startsWith('version ')) {
      return { stdout: '"linux" "x86_64"\n' };
    }

    if (argv.startsWith('pull ')) {
      return answerPull(run, ref);
    }

    if (argv.startsWith('tag ')) {
      return {};
    }

    if (argv === `image inspect --format ${PIN_INSPECT_FORMAT} ${ref}`) {
      return answerPinInspect(ref);
    }

    if (argv === `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`) {
      return isOnEngine(DOCKERFILE_FRONTEND, options.frontend?.isOnEngine)
        ? { stdout: `sha256:${'f'.repeat(64)}\n` }
        : {
            code: 1,
            stderr: `Error response from daemon: No such image: ${DOCKERFILE_FRONTEND}\n`,
          };
    }

    if (argv.startsWith('build ')) {
      const context = await run.readStdin();

      builtContexts.push(context);

      const dockerfile = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], { stdin: context });

      builtDockerfiles.push(new TextDecoder().decode(dockerfile.stdout));

      return options.onBuild === undefined
        ? { stderr: options.buildLog ?? '#1 DONE\n' }
        : options.onBuild(run);
    }

    if (argv === 'image inspect --format {{json .Config}} imp-build:latest') {
      return { stdout: options.config ?? BUILT_CONFIG };
    }

    if (argv === 'create imp-build:latest /bin/true') {
      return { stdout: `${STUB_BUILDER_CONTAINER}\n` };
    }

    if (argv === `export ${STUB_BUILDER_CONTAINER}`) {
      await options.onExport?.();

      return { stdout: options.exported, stall: options.isExportStalled === true };
    }

    return { code: 1, stderr: `the stub builder has no ${argv}` };
  };

  const guest = buildStubGuest(answerRun);

  const builders: Builders = {
    withBuilder: (_signal, run) => {
      counts.boots += 1;
      counts.live += 1;

      return Promise.try(run, createGuestExec(guest.open), STUB_BUILDER_NAME).finally(() => {
        counts.live -= 1;
      });
    },
    removeLeftovers: () => Promise.resolve(),
  };

  return {
    guest,
    builders,
    builtDockerfiles,
    builtContexts,

    readBoots: () => counts.boots,
    readLive: () => counts.live,
  };
}

function readStep(argv: string, ref: string): StubBuilderStep | null {
  const steps: Readonly<Record<string, StubBuilderStep>> = {
    [`image inspect --format ${PIN_INSPECT_FORMAT} ${ref}`]: 'pin',
    [`tag ${argv.split(' ')[1] ?? ''} imp-build:latest`]: 'tag',
    'image inspect --format {{json .Config}} imp-build:latest': 'config',
    'create imp-build:latest /bin/true': 'create',
    [`export ${STUB_BUILDER_CONTAINER}`]: 'export',
  };

  return steps[argv] ?? null;
}
