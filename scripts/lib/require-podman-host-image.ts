import type { $, ShellExpression } from 'bun';
import { DevError } from './dev-error.ts';

type PodmanShell = (
  strings: TemplateStringsArray,
  ...expressions: ShellExpression[]
) => $.ShellPromise;

// The host image builds with docker buildx and its cache, so podman only runs an image loaded from
// Docker's store.
export async function requirePodmanHostImage(shell: PodmanShell, hostImage: string): Promise<void> {
  const exists = await shell`podman image exists ${hostImage}`.quiet().nothrow();

  if (exists.exitCode !== 0) {
    throw new DevError(
      `podman has no ${hostImage} image; load it with: docker save ${hostImage} | podman load`,
    );
  }
}
