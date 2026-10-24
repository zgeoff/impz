import { expect, mock, test } from 'bun:test';
import { instance } from './instance';
import type { CommandRunners } from './instance';
import { stopTailscaleTailnet } from './tailscale-tailnet';

test('#stopTailscaleTailnet removes the run’s member container', async () => {
  const runChecked = mock<CommandRunners['runChecked']>(() => Promise.resolve(''));

  await stopTailscaleTailnet({ runChecked });

  expect(runChecked).toHaveBeenCalledExactlyOnceWith([
    'docker',
    'rm',
    '-f',
    `${instance.container}-ts-member`,
  ]);
});

test('#stopTailscaleTailnet fails with what docker said when the member is not removed', () => {
  const runChecked = mock<CommandRunners['runChecked']>(() =>
    Promise.reject(
      new Error(
        'docker rm -f imp-e2e-a-ts-member exited 1: Error response from daemon: cannot remove container: device or resource busy',
      ),
    ),
  );

  expect(stopTailscaleTailnet({ runChecked })).rejects.toThrowWithMessage(
    Error,
    'docker rm -f imp-e2e-a-ts-member exited 1: Error response from daemon: cannot remove container: device or resource busy',
  );
});
