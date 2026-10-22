import { $ } from 'bun';
import { DevError } from '../lib/dev-error.ts';
import { pickSetting } from '../lib/pick-setting.ts';
import { probeContainerRunning } from './probe-container-running.ts';
import { readLogTail } from './read-log-tail.ts';
import type { Dev } from './types.ts';

const POLL_MS = 500;

// Ready means /health reports the default image seeded.
export async function waitDevReady(dev: Dev, defaultSeconds: number): Promise<void> {
  const seconds = Number(pickSetting(dev.env, 'IMP_DEV_READY_TIMEOUT_S') ?? defaultSeconds);
  const deadline = Date.now() + seconds * 1000;

  for (;;) {
    const health = await $`curl -fsS ${`${dev.layout.apiURL}/health`}`.quiet().nothrow();

    if (health.stdout.toString().includes('"ready":true')) {
      return;
    }

    const isRunning = await probeContainerRunning(dev.layout.name);

    if (!isRunning) {
      const tail = await readLogTail(dev.layout.name, 40);

      throw new DevError(`${dev.layout.name} stopped; last log lines:`, tail);
    }

    if (Date.now() >= deadline) {
      throw new DevError(`impd not ready after ${String(seconds)}s`);
    }

    await Bun.sleep(POLL_MS);
  }
}
