import { expect, mock, test } from 'bun:test';
import type { CommandRunners } from './instance';
import { stopTailscaleTailnet } from './tailscale-tailnet';

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
