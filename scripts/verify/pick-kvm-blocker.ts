export interface KvmHost {
  readonly hasKvm: boolean;
  readonly hasDocker: boolean;
  readonly kernelPath: string;
  readonly hasKernel: boolean;
  readonly hostImage: string;
  readonly hasHostImage: boolean;
}

// Why this machine cannot start a dev instance for the `local-kvm` target, with the step that fixes
// it, or null when it can. The host image counts because a first build of it takes longer than
// `bun verify up` waits for the app's ready line.
export function pickKvmBlocker(host: Readonly<KvmHost>): string | null {
  if (!host.hasKvm) {
    return 'this machine has no /dev/kvm that this user can read and write, so it cannot boot an imp; run the local-kvm journeys on a KVM host';
  }

  if (!host.hasDocker) {
    return '`docker info` fails, and the dev instance runs in a Docker container; start Docker';
  }

  if (!host.hasKernel) {
    return `no guest kernel at ${host.kernelPath}; build it with kernel/build.sh (about 9 minutes the first time), or set IMP_KERNEL`;
  }

  if (!host.hasHostImage) {
    return `this checkout has no host image ${host.hostImage}; build it once with \`IMP_DEV_NAME=wv-image scripts/dev/dev.sh up\`, then \`IMP_DEV_NAME=wv-image scripts/dev/dev.sh down\``;
  }

  return null;
}
