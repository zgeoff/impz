import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ImageRefSchema, NameSchema } from '@impz/api';
import type { ImageBuildPhase } from '@impz/api';
import {
  BuildContextError,
  MissingDockerfileError,
  countTarBytes,
  listContextEntries,
  readBuildContext,
  writeBuildContext,
} from '@impz/local-tar';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
import type { Config } from '../../config';
import type { ImageRecord } from '../../platform/db/images';
import { runCommand } from '../../platform/process/run-command';
import { buildUploadsDir } from '../../vm/storage/data-layout';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import { checkReferenceRegistry, parseImageReference } from '../docker-proxy/rules';
import { createBuildEngine, toEngineRun } from './build-engine';
import type { BuildEngine, EngineRun } from './build-engine';
import { createBuildSlots } from './build-slots';
import type { Builders } from './builder-imps';
import { createBuildRuns } from './create-build-runs';
import type { BuildRuns } from './create-build-runs';
import type { BuildOutput } from './create-build-steps';
import { requireClientImageName } from './create-image-writer';
import type { ImageWriter } from './create-image-writer';
import { DockerBuildError, runDockerBuild } from './docker-build';
import { checkDockerfile, renderPinnedDockerfile } from './dockerfile-check';
import type { ExternalImage } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';
import { runGuestBuild } from './guest-build';
import { formatPinFailure, formatPlatform, pickRepoDigest, readImageStore } from './image-pin';
import type { ImageStore, Pin, PinInspect } from './image-pin';
import { runDocker } from './run-docker';
import { writeContextTar } from './write-context-tar';

const DOCKERFILE_MAX_BYTES = 1024 ** 2;

export const HOST_BUILD_WARNING =
  'impd: WARNING: IMP_BUILD_ISOLATION=host: image builds run on the host engine, whose RUN steps can reach the host and its private networks; for a trusted operator only, and gone in the next release (docs/guides/images.md#isolated-builds)';

interface ImageOpOptions {
  readonly signal?: AbortSignal;
  readonly setPhase?: (phase: ImageBuildPhase) => void;
  readonly output?: BuildOutput | undefined;
  readonly setBuilder?: (name: string) => void;
}

export interface ImageBuilds {
  readonly runImageBuild: (
    contextDir: string,
    name: string,
    dockerfile?: string,
    options?: Readonly<ImageOpOptions>,
  ) => Promise<ImageRecord>;

  readonly buildImageFromContext: (
    tarPath: string,
    name: string,
    dockerfile: string | undefined,
    options: Readonly<ImageOpOptions> & { readonly signal: AbortSignal },
  ) => Promise<ImageRecord>;

  readonly claimBuildSlot: () => () => void;

  readonly startBuildRun: BuildRuns['start'];
  readonly listBuildRuns: BuildRuns['list'];
}

interface ImageBuildsDeps {
  readonly config: Config;

  readonly diskBudget: Pick<DiskBudget, 'withRoom'>;

  readonly readBuilders: () => Builders | null;
  readonly log: (message: string) => void;

  readonly now?: () => number;
}

interface RunHostBuildOptions {
  readonly tarPath: string;
  readonly tag: string;
  readonly dockerfile: string;
  readonly signal: AbortSignal;
  readonly output: BuildOutput | undefined;
}

export function createImageBuilds(deps: ImageBuildsDeps, writer: ImageWriter): ImageBuilds {
  const buildRuns = createBuildRuns(deps.now ?? Date.now);
  const buildSlots = createBuildSlots();

  const resolvePinnedDockerfile = async (
    dockerfile: string,
    images: readonly ExternalImage[],
    engine: BuildEngine,
    signal: AbortSignal,
  ) => {
    const platform = await engine.readPlatform(signal);

    const pins = new Map<string, string>();

    const used: Pin[] = [];

    const stores = new Set<ImageStore>();

    // A registry tag can move between two inspects, so each image is inspected once whatever
    // its spellings (`busybox` is `docker.io/library/busybox:latest`).
    const keys = new Map<string, string>();

    for (const image of images) {
      if (!ImageRefSchema.safeParse(image.ref).success) {
        throw new ORPCError('BAD_REQUEST', {
          message: `${image.use} ${JSON.stringify(image.ref)} is not an image reference`,
        });
      }

      // The engine may hold the image already, and then no pull passes imp-docker-proxy to
      // refuse it.
      const registryProblem = checkReferenceRegistry(image.ref);

      if (registryProblem !== null) {
        throw new ORPCError('BAD_REQUEST', {
          message: `${image.use} ${image.ref}: ${registryProblem}`,
        });
      }

      const key = toImageKey(image.ref);
      const known = keys.get(key);

      if (known === undefined) {
        signal.throwIfAborted();

        const inspect = await engine.loadImage(image, signal);

        keys.set(key, pickPin(image, inspect, platform));
        stores.add(readImageStore(inspect));
      }

      pins.set(image.ref, keys.get(key) ?? '');
    }

    for (const image of images) {
      used.push({ use: image.use, ref: image.ref, pin: pins.get(image.ref) ?? '' });
    }

    const store = [...stores].find((candidate) => candidate !== 'unknown') ?? 'unknown';

    try {
      return { dockerfile: renderPinnedDockerfile(dockerfile, pins, platform), pins: used, store };
    } catch (error) {
      throw toBadRequest(error);
    }
  };

  const runHostBuild = (options: RunHostBuildOptions) =>
    deps.diskBudget.withRoom(statSync(options.tarPath).size, () =>
      runDockerBuild({
        dockerHost: deps.config.dockerHost,
        tarPath: options.tarPath,
        tag: options.tag,
        dockerfile: options.dockerfile,
        signal: options.signal,
        output: options.output,
      }),
    );

  const createFromContext = async (
    tarPath: string,
    name: string,
    givenDockerfile: string | undefined,
    options: Readonly<ImageOpOptions> & { readonly signal: AbortSignal },
  ): Promise<ImageRecord> => {
    const signal = options.signal;
    const imageName = requireClientImageName(name);
    const tag = `imp/${imageName}:latest`;
    const tarBytes = statSync(tarPath).size;
    const dockerfilePath = normalizeDockerfilePath(givenDockerfile);
    const rewrittenPath = `${tarPath}.rewritten`;
    const isolation = deps.config.build.isolation;
    let pins: readonly Pin[] = [];

    try {
      const built = await deps.diskBudget.withRoom(tarBytes, async () => {
        const context = await readBuildContext(
          tarPath,
          dockerfilePath,
          DOCKERFILE_MAX_BYTES,
          signal,
        ).catch((error: unknown) => {
          throw error instanceof BuildContextError
            ? new ORPCError('BAD_REQUEST', { message: error.message })
            : error;
        });

        const dockerfile = context.dockerfilePath ?? 'Dockerfile';

        const named = (() => {
          try {
            return checkDockerfile(context.dockerfile);
          } catch (error) {
            throw toBadRequest(error);
          }
        })();

        const writePinnedContext = async (engine: BuildEngine): Promise<void> => {
          const pinned = await resolvePinnedDockerfile(context.dockerfile, named, engine, signal);

          pins = pinned.pins;

          const pinList = pinned.pins.map((pin) => `${pin.use} ${pin.ref} as ${pin.pin}`);

          deps.log(
            `impd: image build ${name} (${isolation}): image store ${pinned.store}; pinned ${pinList.join(', ') || 'no image'}`,
          );

          signal.throwIfAborted();

          await writeBuildContext({
            inputPath: tarPath,
            outputPath: rewrittenPath,
            checked: context,
            dockerfile: pinned.dockerfile,
            maxDockerfileBytes: DOCKERFILE_MAX_BYTES,
            signal,
          });

          signal.throwIfAborted();

          await engine.loadFrontend(signal);
        };

        if (isolation === 'host') {
          deps.log(HOST_BUILD_WARNING);

          await writePinnedContext(createBuildEngine(runOnHost));

          await runHostBuild({
            tarPath: rewrittenPath,
            tag,
            dockerfile,
            signal,
            output: options.output,
          });

          return null;
        }

        const builders = deps.readBuilders();

        if (builders === null) {
          throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is starting; try again' });
        }

        return builders.withBuilder(signal, async (exec, builderName) => {
          options.setBuilder?.(builderName);
          const started = performance.now();

          await writePinnedContext(createBuildEngine(toEngineRun(exec)));

          const pinned = performance.now();

          await runGuestBuild(exec, {
            tarPath: rewrittenPath,
            dockerfile,
            signal,
            output: options.output,
          });

          const ran = performance.now();

          options.setPhase?.('unpack');

          const image = await writer.writeGuestImage(exec, imageName, tag, signal);

          const pinsMs = Math.round(pinned - started);
          const buildMs = Math.round(ran - pinned);
          const imageMs = Math.round(performance.now() - ran);

          deps.log(
            `impd: image build ${name} (imp): pins=${String(pinsMs)}ms build=${String(buildMs)}ms image=${String(imageMs)}ms`,
          );

          return image;
        });
      });

      signal.throwIfAborted();

      if (built !== null) {
        return built;
      }

      return await writer.createImageOnHost(tag, NameSchema.parse(name), {
        ...(options.setPhase !== undefined && { setPhase: options.setPhase }),
      });
    } catch (error) {
      signal.throwIfAborted();

      if (error instanceof DockerBuildError) {
        throw new ORPCError('BAD_REQUEST', { message: formatPinFailure(error.message, pins) });
      }

      throw error;
    } finally {
      rmSync(rewrittenPath, { force: true });
    }
  };

  const createOnHost = async (
    contextDir: string,
    name: string,
    dockerfile: string | undefined,
    options: Readonly<ImageOpOptions>,
  ): Promise<ImageRecord> => {
    if (!contextDir.startsWith('/')) {
      throw new ORPCError('BAD_REQUEST', {
        message: `build context ${JSON.stringify(contextDir)} is not an absolute path`,
      });
    }

    // The CLI sends a path on its own machine, which impd sees only when the two share a
    // filesystem, as in the dev container.
    if (!existsSync(contextDir)) {
      throw new ORPCError('BAD_REQUEST', {
        message: `build context ${contextDir} does not exist on the impd host; build the image there and use \`impz image add\``,
      });
    }

    // Docker reads no .dockerignore from a context sent as the request body, so impd packs the
    // context itself, as the CLI does.
    const entries = await listContextEntries(contextDir, normalizeDockerfilePath(dockerfile)).catch(
      (error: unknown) => {
        throw error instanceof MissingDockerfileError
          ? new ORPCError('BAD_REQUEST', { message: error.message })
          : error;
      },
    );

    const tarBytes = await countTarBytes(entries);

    const maxBytes = deps.config.buildContextMaxBytes;

    if (tarBytes > maxBytes) {
      throw new ORPCError('BAD_REQUEST', {
        message: `the build context is ${String(tarBytes)} bytes, over the limit of ${String(Math.floor(maxBytes / 1024 ** 2))} MiB (IMP_BUILD_CONTEXT_MAX_MIB)`,
      });
    }

    const uploadsDir = buildUploadsDir(deps.config.dataDir);
    const tarPath = join(uploadsDir, `${Bun.randomUUIDv7()}.tar`);

    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

    return deps.diskBudget.withRoom(tarBytes, async () => {
      try {
        await writeContextTar(entries, tarPath);

        options.setPhase?.('build');

        return await createFromContext(tarPath, name, dockerfile, {
          ...options,
          signal: options.signal ?? new AbortController().signal,
        });
      } finally {
        rmSync(tarPath, { force: true });
      }
    });
  };

  return {
    runImageBuild: async (contextDir, name, dockerfile, options = {}) => {
      const release = buildSlots.claim();
      const run = buildRuns.start(name, 'host');

      try {
        return await createOnHost(contextDir, name, dockerfile, {
          ...options,
          setPhase: (phase) => {
            run.setPhase(phase);
            options.setPhase?.(phase);
          },
          output: {
            emitLog: (line) => {
              options.output?.emitLog(line);
            },
            setStep: (step) => {
              run.setStep(step);
              options.output?.setStep(step);
            },
          },
          setBuilder: (builder) => {
            run.setBuilder(builder);
            options.setBuilder?.(builder);
          },
        });
      } finally {
        run.end();

        release();
      }
    },
    buildImageFromContext: createFromContext,
    claimBuildSlot: buildSlots.claim,
    startBuildRun: buildRuns.start,
    listBuildRuns: buildRuns.list,
  };
}

function toImageKey(ref: string): string {
  const named = parseImageReference(ref);
  const [withoutDigest = '', digest = ''] = ref.split('@');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tagColon = withoutDigest.indexOf(':', lastSlash + 1);
  const tag = tagColon === -1 ? 'latest' : withoutDigest.slice(tagColon + 1);

  return `${named.registry}/${named.path}:${tag}@${digest}`;
}

function pickPin(
  image: Readonly<ExternalImage>,
  inspect: Readonly<PinInspect>,
  platform: string,
): string {
  const ref = image.ref;
  const imagePlatform = formatPlatform(inspect.Os, inspect.Architecture);

  if (imagePlatform !== platform) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: the host has this image for ${imagePlatform}, and builds for ${platform}`,
    });
  }

  // The Dockerfile frontend runs the ONBUILD triggers of every image the build reaches,
  // including a COPY --from or a mount's, where impd cannot check them.
  if ((inspect.OnBuild ?? []).length > 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref} has ONBUILD triggers, which impd refuses`,
    });
  }

  // A pin under a refused registry would let the build reach that registry with no pull for
  // imp-docker-proxy to refuse.
  const repoDigests = inspect.RepoDigests ?? [];
  const allowed = repoDigests.filter((digest) => checkReferenceRegistry(digest) === null);
  const pin = pickRepoDigest(ref, allowed);

  if (pin === null && repoDigests.length > 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: its registry digests name only registries impd refuses: ${repoDigests.join(', ')}`,
    });
  }

  if (pin === null) {
    const advice = image.use === 'FROM' ? 'build FROM' : 'name';

    throw new ORPCError('BAD_REQUEST', {
      message: `${image.use} ${ref}: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; ${advice} a registry image by tag or digest. Local base images are not supported yet (#156).`,
    });
  }

  return pin;
}

function toBadRequest(error: unknown): unknown {
  return error instanceof DockerfileError
    ? new ORPCError('BAD_REQUEST', { message: `the Dockerfile: ${error.message}` })
    : error;
}

function runOnHost(argv: readonly string[], signal: AbortSignal): ReturnType<EngineRun> {
  const [command, ...args] = argv;

  return command === 'docker' ? runDocker(args, { signal }) : runCommand(argv, { signal });
}

/* @internal */
export function normalizeDockerfilePath(path: string | undefined): string {
  const normalized = posix.normalize(path ?? 'Dockerfile');

  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized === '.' ||
    normalized.endsWith('/')
  ) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the Dockerfile path ${JSON.stringify(path)} is not a file inside the build context`,
    });
  }

  return normalized;
}
