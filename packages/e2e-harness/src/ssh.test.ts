import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { updateEnv } from '@impz/test-utils/update-env';
import { runCommand } from './instance';
import { listAgentThroughUnixForward, startLocalSshAgent } from './ssh';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('#listAgentThroughUnixForward lists the agent at the far end of the forward, and removes the local socket', async () => {
  const ctx = await setupTest();

  const ssh = createStubBin(
    ctx.directoryPath,
    'ssh',
    [
      'for arg in "$@"; do',
      '  if [ "$prev" = -L ]; then spec=$arg; fi',
      '  prev=$arg',
      'done',
      'echo "forward $spec" >&2',
      String.raw`exec ssh-agent -D -a "$(printf '%s' "$spec" | cut -d: -f1)" >/dev/null 2>&1`,
    ].join('\n'),
  );

  updateEnv('PATH', `${ssh.bin}:${process.env['PATH'] ?? ''}`);

  const local = join(ctx.directoryPath, 'dev.sock');

  const forwarded = await listAgentThroughUnixForward(
    {
      configArgs: ['-F', join(ctx.directoryPath, 'config')],
      directory: ctx.directoryPath,
      cleanup: () => Promise.resolve(),
    },
    'e2e-sa-unix',
    '/tmp/e2e-dev.sock',
    local,
  );

  expect(forwarded).toStrictEqual({
    listed: { exitCode: 1, stdout: 'The agent has no identities.\n', stderr: '' },
    forwardLog: `forward ${local}:/tmp/e2e-dev.sock\n`,
  });

  expect(existsSync(local)).toBeFalse();
});

test('#startLocalSshAgent serves the key it made until stop, which removes its socket', async () => {
  const ctx = await setupTest();

  const agent = await startLocalSshAgent(
    { configArgs: [], directory: ctx.directoryPath, cleanup: () => Promise.resolve() },
    'unit',
  );

  onTestFinished(() => agent.stop());

  const listed = await runCommand(['ssh-add', '-L'], { env: { SSH_AUTH_SOCK: agent.socket } });

  await agent.stop();

  expect(listed).toStrictEqual({ exitCode: 0, stdout: agent.publicKey, stderr: '' });
  expect(agent.publicKey).toEndWith(' imp-e2e-unit\n');
  expect(existsSync(agent.socket)).toBeFalse();
});

test('#startLocalSshAgent serves its key from a socket under /tmp when TMPDIR is long', async () => {
  const ctx = await setupTest();

  const longTmp = join(
    ctx.directoryPath,
    'a-temporary-folder-whose-path-is-long-enough-to-pass-the-limit',
  );

  await mkdir(longTmp);

  updateEnv('TMPDIR', longTmp);

  const agent = await startLocalSshAgent(
    { configArgs: [], directory: ctx.directoryPath, cleanup: () => Promise.resolve() },
    'unit',
  );

  onTestFinished(() => agent.stop());

  const listed = await runCommand(['ssh-add', '-L'], { env: { SSH_AUTH_SOCK: agent.socket } });

  expect(listed).toStrictEqual({ exitCode: 0, stdout: agent.publicKey, stderr: '' });
  expect(agent.socket).toStartWith('/tmp/imp-agent-');
});

test('#startLocalSshAgent refuses a socket path past the unix socket limit, naming it', async () => {
  const ctx = await setupTest();

  expect(
    startLocalSshAgent(
      { configArgs: [], directory: ctx.directoryPath, cleanup: () => Promise.resolve() },
      'a-label-long-enough-that-the-socket-path-passes-the-limit-of-a-unix-socket-path-on-linux',
    ),
  ).rejects.toThrowWithMessage(
    Error,
    /^ssh-agent socket \/tmp\/imp-agent-.* is longer than 107 bytes$/u,
  );
});

test('#startLocalSshAgent stops again without an error once it has stopped', async () => {
  const ctx = await setupTest();

  const agent = await startLocalSshAgent(
    { configArgs: [], directory: ctx.directoryPath, cleanup: () => Promise.resolve() },
    'unit',
  );

  onTestFinished(() => agent.stop());

  await agent.stop();

  await expect(agent.stop()).toResolve();
});
