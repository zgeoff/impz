import { expect, test } from 'bun:test';
import { runInContainer } from '../lib/instance';

test('it gives the dev container no Docker socket and no docker binary', async () => {
  const hostSocket = await runInContainer(['test', '-e', '/var/run/docker.sock']);
  const socketDirectory = await runInContainer(['test', '-e', '/run/imp-docker']);
  const docker = await runInContainer(['sh', '-c', 'command -v docker']);

  expect(hostSocket.exitCode).toBe(1);
  expect(socketDirectory.exitCode).toBe(1);
  expect(docker.exitCode).not.toBe(0);
  expect(docker.stdout).toBe('');
});
