import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { REPO_ROOT } from '../lib/repo-root.ts';
import { buildKvmInstance } from './build-kvm-instance.ts';
import { IMAGE_NAME, RUN_DIRECTORY_ENV, SERVICE_DIGEST_ENV } from './constants.ts';
import { createCLIHome } from './create-cli-home.ts';
import { readKvmBlocker } from './read-kvm-blocker.ts';
import { readPortOffset } from './read-port-offset.ts';
import { removeKvmInstance } from './remove-kvm-instance.ts';
import { waitForStop } from './wait-for-stop.ts';
import { writeServiceFiles } from './write-service-files.ts';

const DEV_SH = join(REPO_ROOT, 'scripts', 'dev', 'dev.sh');
const TINY_FIXTURE = join(REPO_ROOT, 'packages', 'daemon', 'e2e', 'fixtures', 'tiny');

// A port that nothing answers on, for the endpoints of a run whose instance never started.
const NO_INSTANCE = 'http://127.0.0.1:9';

// The checkout mounts into the dev container at its own path, so impd reads the service files from
// the run folder. A host that can't run an instance still prints a ready line, with the reason in
// `blocked`, so the doctor names the fix in place of a launch timeout.
export async function runKvmImpd(env: Readonly<Record<string, string | undefined>>) {
  const directory = env[RUN_DIRECTORY_ENV];
  const digest = env[SERVICE_DIGEST_ENV];

  invariant(directory !== undefined && digest !== undefined, 'the launch plan sets both');

  const blocked = await readKvmBlocker(env);

  if (blocked !== null) {
    writeReadyLine({
      web: NO_INSTANCE,
      mcp: NO_INSTANCE,
      configHome: directory,
      bin: directory,
      tokenFile: join(directory, 'token'),
      blocked,
    });

    await waitForStop();

    return;
  }

  try {
    await startInstance(env, directory, digest);
    await waitForStop();
  } finally {
    await removeKvmInstance(directory);
  }
}

function writeReadyLine(endpoints: Readonly<Record<string, string>>): void {
  process.stdout.write(`${JSON.stringify({ event: 'ready', ...endpoints })}\n`);
}

async function startInstance(
  env: Readonly<Record<string, string | undefined>>,
  directory: string,
  digest: string,
): Promise<void> {
  const instance = buildKvmInstance(directory);
  const offset = readPortOffset();
  const web = `http://127.0.0.1:${String(7070 + offset)}`;
  const mcp = `http://127.0.0.1:${String(7071 + offset)}`;

  const files = await writeServiceFiles(directory, `${mcp}/mcp`, digest);

  const devEnv = {
    ...env,
    IMP_DEV_NAME: instance.name,
    IMP_DEV_PORT_OFFSET: String(offset),
    IMP_DEV_DATA: instance.dataDir,
    IMP_DEV_TAILNET: '0',
    IMP_STORAGE_GIB: '20',
    IMP_MCP_PUBLIC_URL: mcp,
    IMP_MCP_SERVICE_TOKEN_FILE: files.tokenFile,
    IMP_MCP_SERVICE_CLIENTS_FILE: files.clientsFile,
  };

  await $`${DEV_SH} up`.env(devEnv);

  const token = await $`${DEV_SH} token`.env(devEnv).quiet().text();
  const home = await createCLIHome(directory, web, token.trim());

  await $`${join(home.bin, 'impz')} image build ${TINY_FIXTURE} --name ${IMAGE_NAME}`.env({
    ...env,
    XDG_CONFIG_HOME: home.configHome,
  });

  writeReadyLine({ web, mcp, ...home });
}

if (import.meta.main) {
  await runKvmImpd(process.env);
}
