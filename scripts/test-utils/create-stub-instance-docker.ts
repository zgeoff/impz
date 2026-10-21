import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface InstanceDockerStubOptions {
  readonly containers: readonly string[];
  readonly startedLater?: Readonly<{ marker: string; containers: readonly string[] }>;
  readonly networks?: readonly string[];
}

export function createStubInstanceDocker(
  stubs: string,
  options: Readonly<InstanceDockerStubOptions>,
): StubBin {
  const names = options.containers.map((name) => `'${name}'`).join(' ');
  const marker = options.startedLater?.marker ?? '';
  const later = (options.startedLater?.containers ?? []).map((name) => `'${name}'`).join(' ');
  const networks = (options.networks ?? []).map((name) => `'${name}'`).join(' ');

  return createStubBin(
    stubs,
    'docker',
    `if [ "$1" = container ] && [ "$2" = inspect ]; then
  for name in ${names}; do
    [ "$name" != "$3" ] || exit 0
  done
  if [ -n '${marker}' ] && [ -e '${marker}' ]; then
    for name in ${later}; do
      [ "$name" != "$3" ] || exit 0
    done
  fi
  echo "Error: No such container: $3" >&2
  exit 1
fi
if [ "$1" = network ] && [ "$2" = inspect ]; then
  for name in ${networks}; do
    [ "$name" != "$3" ] || exit 0
  done
  echo "Error response from daemon: network $3 not found" >&2
  exit 1
fi`,
  );
}
