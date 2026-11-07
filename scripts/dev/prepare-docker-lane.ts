// A lane's first test pays for an image pull, and on a fresh CI runner for the engine's first
// container, 2 to 5 s more than a later test. This pays both before the tests start.
import { PEBBLE_IMAGES } from '@impz/daemon/test-utils/network/pebble-images';
import type { LaneContext } from '@zgeoff/rig';
import invariant from 'tiny-invariant';
import * as z from 'zod';
import { HEADSCALE_IMAGES } from './headscale-images';

const LANE_IMAGES = { pebble: PEBBLE_IMAGES, headscale: HEADSCALE_IMAGES } as const;

export default function prepareDockerLane(context: LaneContext): void {
  const lane = z.enum(['pebble', 'headscale']).parse(context.lane.name);
  const images = Object.entries(LANE_IMAGES[lane]);
  const network = `imp-${lane}-lane-warm-up-${context.runID}`;
  const runDocker = makeDockerRunner(context.environment);

  for (const [, image] of images) {
    runDocker(['pull', '--quiet', image]);
  }

  const started = performance.now();

  runDocker(['network', 'create', network]);

  let startFailure: Error | null = null;

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
  } catch (error) {
    invariant(error instanceof Error);

    startFailure = error;
  }

  const removalFailures = [
    ['rm', '--force', ...images.map(([key]) => `${network}-${key}`)],
    ['network', 'rm', network],
  ].flatMap((args) => {
    const removal = Bun.spawnSync(['docker', ...args], {
      env: context.environment,
      stdout: 'ignore',
      stderr: 'inherit',
    });

    return removal.exitCode === 0
      ? []
      : [`docker ${args.join(' ')} exited ${String(removal.exitCode)}`];
  });

  if (removalFailures.length > 0) {
    throw new Error(removalFailures.join('\n'), { cause: startFailure });
  }

  if (startFailure !== null) {
    throw startFailure;
  }

  const firstContainersMs = Math.round(performance.now() - started);

  console.error(`${lane} lane: first containers ${String(firstContainersMs)} ms`);
}

function makeDockerRunner(
  environment: LaneContext['environment'],
): (args: readonly string[]) => void {
  return (args) => {
    const result = Bun.spawnSync(['docker', ...args], {
      env: environment,
      stdout: args[0] === 'pull' ? 'inherit' : 'ignore',
      stderr: 'inherit',
    });

    if (result.exitCode !== 0) {
      throw new Error(`docker ${args.join(' ')} exited ${String(result.exitCode)}`);
    }
  };
}
