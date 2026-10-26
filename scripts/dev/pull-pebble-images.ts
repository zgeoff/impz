// A pull inside a Pebble test would spend that test's time budget.
import { PEBBLE_IMAGES } from '@impz/daemon/testing/pebble-images';

for (const image of Object.values(PEBBLE_IMAGES)) {
  const pull = Bun.spawnSync(['docker', 'pull', '--quiet', image], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (pull.exitCode !== 0) {
    throw new Error(`docker pull ${image} exited ${String(pull.exitCode)}`);
  }
}
