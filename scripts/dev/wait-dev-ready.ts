import { DevError } from '../lib/dev-error.ts';
import { parseSecondsSetting } from '../lib/parse-seconds-setting.ts';
import { probeContainerRunning } from './probe-container-running.ts';
import { readLogTail } from './read-log-tail.ts';
import type { Dev } from './types.ts';

const POLL_MS = 500;

export async function waitDevReady(dev: Dev, defaultSeconds: number): Promise<void> {
  const seconds = parseSecondsSetting(dev.env, 'IMP_DEV_READY_TIMEOUT_S', defaultSeconds);
  const deadline = dev.io.now() + seconds * 1000;

  for (;;) {
    const health = await dev.io.shell`curl -fsS ${`${dev.layout.apiURL}/health`}`.quiet().nothrow();

    // A transfer that fails after the body started still exits nonzero.
    if (health.exitCode === 0 && health.stdout.toString().includes('"ready":true')) {
      return;
    }

    const isRunning = await probeContainerRunning(dev);

    if (!isRunning) {
      const tail = await readLogTail(dev, 40);

      throw new DevError(`${dev.layout.name} stopped; last log lines:`, tail);
    }

    if (dev.io.now() >= deadline) {
      throw new DevError(`impd not ready after ${String(seconds)}s`);
    }

    await dev.io.sleep(POLL_MS);
  }
}
