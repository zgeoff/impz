import { onTestFinished } from 'bun:test';
import { readFileSync } from 'node:fs';
import { waitFor } from '@impz/test-utils/wait-for';

export async function startStubFirecrackerProcess(apiSocket: string) {
  // bash's own read waits on the open stdin pipe, so the stand-in runs no
  // child that its SIGKILL would orphan
  const child = Bun.spawn(
    ['bash', '-c', `exec -a firecracker bash -c 'read -t 30 || true' x --api-sock "$0"`, apiSocket],
    { stdin: 'pipe' },
  );

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  // the socket is in bash's own command line before the exec renames it
  await waitFor(() => {
    const cmdline = readFileSync(`/proc/${String(child.pid)}/cmdline`, 'utf8').split('\0');

    if (cmdline[0] !== 'firecracker' || !cmdline.includes(apiSocket)) {
      throw new Error(`the stand-in has not exec'd yet: ${cmdline.join(' ')}`);
    }
  });

  return child;
}
