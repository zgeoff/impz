import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { setupLogging } from './platform/process/setup-logging';
import { renderNetworkEnv } from './render-network-env';

async function main(): Promise<void> {
  setupLogging();

  const impd = await createImpd(loadConfig(process.env));

  const stopState = { stopping: false };

  // A container stop sends SIGTERM, and a sleep keeps each imp's memory across the restart.
  // SIGHUP restarts impd in place, and the next impd re-adopts the running VMs.
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

// The release pipeline checks `impd --version` against the tag it publishes, and
// host/entrypoint runs `impd --network-env`.
if (process.argv[2] === '--version') {
  process.stdout.write(`${packageJson.version}\n`);
} else if (process.argv[2] === '--network-env') {
  process.stdout.write(renderNetworkEnv(process.env));
} else {
  await main();
}
