import * as z from 'zod';
import { ImpdError } from '../../../platform/errors/impd-error';
import {
  formatFamiliarRepository,
  parseImageReference,
} from '../../docker-contract/parse-image-reference';

export const PIN_INSPECT_FORMAT =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Config":{{json .Config}}}';

// The docker CLI renders a config with no triggers without the key, and a
// template that names it fails, so impd reads the whole config.
const ConfigSchema = z.object({ OnBuild: z.array(z.unknown()).readonly().nullish() }).nullable();

export const PinInspectSchema = z
  .object({
    Id: z.string(),
    RepoDigests: z.array(z.string()).readonly().nullable(),
    Os: z.string(),
    Architecture: z.string(),
    Config: ConfigSchema,
  })
  .transform((inspect) => ({
    Id: inspect.Id,
    RepoDigests: inspect.RepoDigests,
    Os: inspect.Os,
    Architecture: inspect.Architecture,
    OnBuild: inspect.Config?.OnBuild ?? null,
  }));

export type PinInspect = z.output<typeof PinInspectSchema>;

// The architecture names containerd's platforms.Normalize maps.
const ARCHITECTURES = new Map([
  ['x86_64', 'amd64'],
  ['x86-64', 'amd64'],
  ['aarch64', 'arm64'],
  ['i386', '386'],
  ['i686', '386'],
]);

/* @internal */
export function formatPlatform(os: string, architecture: string): string {
  const arch = architecture.toLowerCase();

  return `${os.toLowerCase()}/${ARCHITECTURES.get(arch) ?? arch}`;
}

export function normalizePlatform(os: string, architecture: string): string {
  const platform = formatPlatform(os, architecture);

  // 32-bit arm needs a platform variant that the engine's version output lacks.
  if (!/^linux\/[a-z0-9]+$/v.test(platform) || platform === 'linux/arm') {
    throw new Error(
      `impd builds images on linux hosts other than 32-bit arm, not ${os}/${architecture.toLowerCase()}`,
    );
  }

  return platform;
}

export function requireImagePlatform(
  subject: string,
  inspect: Readonly<PinInspect>,
  platform: string,
): void {
  const imagePlatform = formatPlatform(inspect.Os, inspect.Architecture);

  if (imagePlatform !== platform) {
    throw new ImpdError('BAD_REQUEST', {
      message: `${subject} is for ${imagePlatform}, and the builder builds for ${platform}`,
    });
  }
}

export function pickRepoDigest(ref: string, repoDigests: readonly string[]): string | null {
  const parsed = parseImageReference(ref);
  const repository = formatFamiliarRepository(parsed);

  if (parsed.digest !== null) {
    return `${repository}@${parsed.digest}`;
  }

  const own = repoDigests.find((entry) => entry.split('@')[0] === repository);

  return own ?? repoDigests[0] ?? null;
}

export type ImageStore = 'containerd' | 'classic' | 'unknown';

// The containerd image store's ID is a manifest or index digest, which RepoDigests holds;
// the classic store's ID is the config's digest, which RepoDigests never holds.
export function readImageStore(inspect: Readonly<PinInspect>): ImageStore {
  const digests = inspect.RepoDigests ?? [];

  if (digests.length === 0) {
    return 'unknown';
  }

  return digests.some((digest) => digest.endsWith(`@${inspect.Id}`)) ? 'containerd' : 'classic';
}

export interface Pin {
  readonly use: string;
  readonly ref: string;
  readonly pin: string;
}

const PULL_DENIED = /pull access denied|repository does not exist/v;

export function formatPinFailure(message: string, pins: readonly Pin[]): string {
  if (pins.length === 0 || !PULL_DENIED.test(message)) {
    return message;
  }

  const pinned = pins.map((entry) => `${entry.use} ${entry.ref} as ${entry.pin}`).join(', ');

  return `${message}\nimpd pinned ${pinned}. On the containerd image store a retag of a multi-platform image cannot be pinned: build FROM its original repository, such as busybox:1.37, instead of the retag.`;
}
