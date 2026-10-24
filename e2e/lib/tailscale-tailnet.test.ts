import { expect, mock, test } from 'bun:test';
import { buildStubDockerRunner } from '../../scripts/test-utils/build-stub-docker-runner';
import { instance } from './instance';
import type { CommandRunners } from './instance';
import { stopTailscaleTailnet } from './tailscale-tailnet';

test('#stopTailscaleTailnet removes the run’s member container and no other', async () => {
  const docker = buildStubDockerRunner([
    `${instance.container}-ts-member`,
    instance.container,
    'imp-e2e-b-ts-member',
  ]);

  await stopTailscaleTailnet({ runChecked: docker.runChecked });

  expect(docker.listContainers()).toStrictEqual([instance.container, 'imp-e2e-b-ts-member']);
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
