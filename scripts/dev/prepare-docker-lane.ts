// A lane's first test pays for an image pull, and on a fresh CI runner for the engine's first
// container, 2 to 5 s more than a later test. This pays both before the tests start.
import { PEBBLE_IMAGES } from '@impz/daemon/testing/pebble-images';
import * as z from 'zod';
import { HEADSCALE_IMAGES } from './headscale-images';

const LANE_IMAGES = { pebble: PEBBLE_IMAGES, headscale: HEADSCALE_IMAGES } as const;
const lane = z.enum(['pebble', 'headscale']).parse(Bun.argv[2]);
const images = Object.entries(LANE_IMAGES[lane]);
const network = `imp-${lane}-lane-warm-up-${String(process.pid)}`;

for (const [, image] of images) {
  runDocker(['pull', '--quiet', image]);
}

const started = performance.now();

runDocker(['network', 'create', network]);

try {
  for (const [key, image] of images) {
    runDocker([
      'create',
      '--name',
      `${network}-${key}`,
      '--network',
      network,
      '-p',
      '127.0.0.1::80',
      image,
    ]);

    runDocker(['start', `${network}-${key}`]);
  }
} finally {
  Bun.spawnSync(['docker', 'rm', '--force', ...images.map(([key]) => `${network}-${key}`)], {
    stdout: 'ignore',
  });

  Bun.spawnSync(['docker', 'network', 'rm', network], { stdout: 'ignore' });
}

const firstContainersMs = Math.round(performance.now() - started);

console.error(`${lane} lane: first containers ${String(firstContainersMs)} ms`);

function runDocker(args: readonly string[]): void {
  const result = Bun.spawnSync(['docker', ...args], {
    stdout: args[0] === 'pull' ? 'inherit' : 'ignore',
    stderr: 'inherit',
  });

  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(' ')} exited ${String(result.exitCode)}`);
  }
}
