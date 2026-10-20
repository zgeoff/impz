import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { setupLogging } from './platform/process/setup-logging';
import { renderNetworkEnv } from './render-network-env';

async function main(): Promise<void> {
  setupLogging();

  const impd = await createImpd(loadConfig(process.env));

  const stopState = { stopping: false };

  // SIGTERM and SIGINT (container stop): every running imp goes to sleep, so a container
  // restart keeps memory. SIGHUP (impd restart in place): VMs keep running and the next impd
  // re-adopts them (docs/architecture/lifecycle/lifecycle.md#recovery-after-a-restart).
  const stopOnSignal = (sleepImps: boolean): void => {
    if (stopState.stopping) {
      return;
    }

    stopState.stopping = true;

    void (async () => {
      await impd.stop({ sleepImps });

      process.exit(0);
    })();
  };

  process.on('SIGINT', () => {
    stopOnSignal(true);
  });

  process.on('SIGTERM', () => {
    stopOnSignal(true);
  });

  process.on('SIGHUP', () => {
    stopOnSignal(false);
  });
}

// The release pipeline runs `impd --version` in the built image to check it
// reports the tag it is published under. host/entrypoint runs `impd --network-env`.
if (process.argv[2] === '--version') {
  process.stdout.write(`${packageJson.version}\n`);
} else if (process.argv[2] === '--network-env') {
  process.stdout.write(renderNetworkEnv(process.env));
} else {
  await main();
}
