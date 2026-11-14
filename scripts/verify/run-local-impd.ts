import { TEST_TOKEN, startTestImpd } from '@impz/testing';
import invariant from 'tiny-invariant';
import { IMAGE_NAME, RUN_DIRECTORY_ENV, SERVICE_DIGEST_ENV } from './constants.ts';
import { createCLIHome } from './create-cli-home.ts';
import { readFreePort } from './read-free-port.ts';
import { readPeakMemory } from './read-peak-memory.ts';
import { waitForStop } from './wait-for-stop.ts';
import { writeServiceFiles } from './write-service-files.ts';

// The `local` target's app: impd on stand-in VMs, so it runs on any host, with the public MCP
// route on a loopback port. It boots no VM and runs no command in an imp.
export async function runLocalImpd(env: Readonly<Record<string, string | undefined>>) {
  const directory = env[RUN_DIRECTORY_ENV];
  const digest = env[SERVICE_DIGEST_ENV];

  invariant(directory !== undefined && digest !== undefined, 'the launch plan sets both');

  const port = readFreePort();
  const origin = `http://127.0.0.1:${String(port)}`;

  const files = await writeServiceFiles(directory, `${origin}/mcp`, digest);

  const impd = await startTestImpd({
    env: {
      IMP_MCP_PUBLIC_URL: origin,
      IMP_MCP_PUBLIC_PORT: String(port),
      IMP_MCP_SERVICE_TOKEN_FILE: files.tokenFile,
      IMP_MCP_SERVICE_CLIENTS_FILE: files.clientsFile,
    },
    onLog: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });

  await impd.seedImage(IMAGE_NAME);

  const home = await createCLIHome(directory, impd.url, TEST_TOKEN);

  process.stdout.write(
    `${JSON.stringify({ event: 'ready', web: impd.url, mcp: origin, ...home })}\n`,
  );

  await waitForStop();

  process.stdout.write(
    `${JSON.stringify({ event: 'peak-memory', ...(await readPeakMemory()) })}\n`,
  );

  await impd.stop();
}

if (import.meta.main) {
  await runLocalImpd(process.env);
}
