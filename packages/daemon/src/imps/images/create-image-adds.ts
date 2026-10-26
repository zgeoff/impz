import { ImageRefSchema, NameSchema } from '@impz/api';
import type { ImageBuildPhase } from '@impz/api';
import { listImages, readImageByName } from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { ImpdError } from '../../platform/errors/impd-error';
import type { Clock } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createSingleFlight } from '../../platform/process/single-flight';
import { checkReferenceRegistry } from '../docker-contract/check-registry';
import { parseImageReference } from '../docker-contract/parse-image-reference';
import type { ImpsConfig } from '../imps-config';
import { createBuildEngine, toEngineRun } from './build/build-engine';
import { loadGuestImage } from './build/guest-build';
import { BUILDER_IMAGE } from './builders/builder-imps';
import type { Builders } from './builders/builder-imps';
import { deriveImageName } from './image-naming';
import { requireClientImageName } from './require-client-image-name';
import { requireDockerImage } from './rootfs/create-image-writer';
import type { ImageWriter } from './rootfs/create-image-writer';

export const FALLBACK_DEFAULT_IMAGE = 'ubuntu';
const SEED_REF = 'ubuntu:24.04';

interface AddImageOptions {
  readonly setPhase?: (phase: ImageBuildPhase) => void;

  readonly signal?: AbortSignal | undefined;

  readonly onResolved?: (reference: string) => void;
}

interface AddFromRefOptions extends AddImageOptions {
  readonly signal: AbortSignal;
}

export interface ImageAdds {
  readonly addImage: (
    ref: string,
    name?: string,
    options?: Readonly<AddImageOptions>,
  ) => Promise<ImageRecord>;

  readonly seedDefaultImage: () => Promise<void>;

  readonly ensureBuilderImage: (signal?: AbortSignal) => Promise<void>;
}

interface ImageAddsDeps {
  readonly config: ImpsConfig;
  readonly db: ImpDatabase;

  readonly readBuilders: () => Builders | null;

  readonly clock: Pick<Clock, 'now'>;

  readonly builderImagePullMs?: number | undefined;

  readonly startPullLimit?: (pullMs: number) => AbortSignal;

  readonly seedRef?: string | null;
}

const BUILDER_IMAGE_PULL_MS = 600_000;

export function createImageAdds(deps: ImageAddsDeps, writer: ImageWriter): ImageAdds {
  const createImageInBuilder = (
    ref: string,
    imageName: string,
    options: Readonly<AddFromRefOptions>,
  ): Promise<ImageRecord> => {
    const signal = options.signal;
    const builders = deps.readBuilders();

    if (builders === null) {
      throw new ImpdError('SERVICE_UNAVAILABLE', { message: 'impd is starting; try again' });
    }

    const explicitRef = formatExplicitRef(ref);

    return builders.withBuilder(signal, async (exec) => {
      const started = deps.clock.now();

      const platform = await createBuildEngine(toEngineRun(exec)).readPlatform(signal);
      const pulled = await loadGuestImage(exec, { ref: explicitRef, platform, signal });

      if (pulled !== null) {
        options.onResolved?.(pulled);
      }

      const pullMs = Math.round(deps.clock.now() - started);

      options.setPhase?.('unpack');

      const image = await writer.writeGuestImage(exec, imageName, ref, signal);

      const imageMs = Math.round(deps.clock.now() - started) - pullMs;

      getImpdLogger('image').info(
        'image add {imageName}: {ref} for {platform}{resolved}, digest {digest}; pull={pullMs}ms image={imageMs}ms',
        {
          imageName,
          ref: explicitRef,
          platform,
          resolved: pulled === null ? '' : ` (${pulled})`,
          digest: image.digest,
          pullMs,
          imageMs,
        },
      );

      return image;
    });
  };

  const createImageFromRef = async (
    ref: string,
    name: string | undefined,
    isImpds: boolean,
    options: Readonly<AddFromRefOptions>,
  ): Promise<ImageRecord> => {
    assertImageRef(ref);

    // A builder's pull reaches a literal address, so impd refuses these registries before any
    // builder boots.
    const registryProblem = checkReferenceRegistry(ref);

    if (registryProblem !== null) {
      throw new ImpdError('BAD_REQUEST', { message: `image ${ref}: ${registryProblem}` });
    }

    const givenName = name ?? deriveImageName(ref);
    const imageName = isImpds ? NameSchema.parse(givenName) : requireClientImageName(givenName);

    const taken = await readImageByName(deps.db, imageName);

    requireDockerImage(taken);

    return createImageInBuilder(ref, imageName, options);
  };

  const builderImage = createSingleFlight<ImageRecord>();

  const createBuilderImage = async (ref: string): Promise<ImageRecord> => {
    const pullMs = deps.builderImagePullMs ?? BUILDER_IMAGE_PULL_MS;
    const timeout = deps.startPullLimit?.(pullMs) ?? AbortSignal.timeout(pullMs);
    const step = { fetched: false };

    try {
      return await writer.createBuilderImage(BUILDER_IMAGE, {
        signal: timeout,
        onFetched: () => {
          step.fetched = true;
        },
      });
    } catch (error) {
      const reason =
        timeout.aborted && !step.fetched
          ? `the fetch did not finish in ${formatPullLimit(pullMs)}`
          : getErrorMessage(error);

      throw new ImpdError('SERVICE_UNAVAILABLE', {
        message: `impd cannot add its builder image ${ref} (IMP_BUILD_IMAGE) from its registry, so no image add or build can run: ${reason}`,
      });
    }
  };

  const loadBuilderImage = async (signal?: AbortSignal): Promise<void> => {
    const ref = deps.config.build.image;

    const image = await readImageByName(deps.db, BUILDER_IMAGE);

    if (image?.ref === ref) {
      return;
    }

    await waitForPull(
      builderImage.run(BUILDER_IMAGE, () => createBuilderImage(ref)),
      signal,
    );
  };

  return {
    addImage: (ref, name, options) =>
      createImageFromRef(ref, name, false, {
        ...options,
        signal: options?.signal ?? new AbortController().signal,
      }),
    ensureBuilderImage: loadBuilderImage,

    seedDefaultImage: async () => {
      const images = await listImages(deps.db);

      const seedRef = deps.seedRef === undefined ? SEED_REF : deps.seedRef;

      if (seedRef !== null && images.every((image) => image.name === BUILDER_IMAGE)) {
        await createImageFromRef(seedRef, FALLBACK_DEFAULT_IMAGE, true, {
          signal: new AbortController().signal,
        });
      }
    },
  };
}

function formatExplicitRef(ref: string): string {
  const parsed = parseImageReference(ref);

  return parsed.digest === null && parsed.tag === null ? `${ref}:latest` : ref;
}

// The ref goes into docker's argv, where a leading `-` reads as a flag, so every caller is
// checked, not only the API's.
function assertImageRef(ref: string): void {
  if (!ImageRefSchema.safeParse(ref).success) {
    throw new ImpdError('BAD_REQUEST', {
      message: `invalid image reference ${JSON.stringify(ref)}`,
    });
  }
}

function formatPullLimit(pullMs: number): string {
  return pullMs >= 60_000 ? `${String(pullMs / 60_000)} minutes` : `${String(pullMs / 1000)} s`;
}

async function waitForPull(pulling: Promise<unknown>, signal: AbortSignal | undefined) {
  if (signal === undefined) {
    await pulling;

    return;
  }

  signal.throwIfAborted();

  const aborted = Promise.withResolvers<never>();

  const stopWaiting = () => {
    aborted.reject(signal.reason);
  };

  signal.addEventListener('abort', stopWaiting, { once: true });

  try {
    await Promise.race([pulling, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', stopWaiting);
  }
}
