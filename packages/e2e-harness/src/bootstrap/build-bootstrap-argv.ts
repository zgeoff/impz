export type BootstrapMode = '--check' | '--yes';

export const ARCHIVE_DIR = '/mnt/archive';

interface BootstrapArgvOptions {
  readonly mode: BootstrapMode;
  readonly storage: readonly string[];
  readonly extra: readonly string[];
  readonly image: string;
  readonly health: boolean;
  readonly stub: boolean;
}

export function buildBootstrapArgv(options: BootstrapArgvOptions): readonly string[] {
  const health = options.health ? [] : ['--skip-health'];

  // The stub never starts tailscaled, so it can carry a fake key; the real image would try to join
  // with it.
  const authkey = options.stub ? ['--tailscale-authkey-file', `${ARCHIVE_DIR}/authkey`] : [];

  return [
    options.mode,
    ...options.storage,
    ...options.extra,
    '--image',
    options.image,
    '--image-archive',
    `${ARCHIVE_DIR}/image.tar`,
    ...health,
    ...authkey,
  ];
}
