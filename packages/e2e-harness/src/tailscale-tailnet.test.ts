import { expect, mock, test } from 'bun:test';
import { buildStubDockerRunner } from '../../../scripts/test-utils/build-stub-docker-runner';
import { instance } from './instance';
import type { CommandRunners } from './instance';
import { MEMBER_OWNER_LABEL, stopTailscaleTailnet } from './tailscale-tailnet';

test('#stopTailscaleTailnet removes the member this harness started and no other container', async () => {
  const docker = buildStubDockerRunner([
    {
      name: `${instance.container}-ts-member`,
      labels: { [MEMBER_OWNER_LABEL]: instance.container },
    },
    { name: instance.container },
    { name: 'imp-e2e-b-ts-member', labels: { [MEMBER_OWNER_LABEL]: 'imp-e2e-b' } },
  ]);

  await stopTailscaleTailnet(docker);

  expect(docker.listContainers()).toStrictEqual([instance.container, 'imp-e2e-b-ts-member']);
});

test('#stopTailscaleTailnet never removes a container of the member’s name that no harness started', async () => {
  const docker = buildStubDockerRunner([{ name: `${instance.container}-ts-member` }]);

  const refusal = await stopTailscaleTailnet(docker).then(
    () => null,
    (error: unknown) => error,
  );

  expect(refusal).toMatchObject({
    message: `${instance.container}-ts-member is not a tailnet member this harness started for ${instance.container}, so it stays: remove it or set another IMP_DEV_NAME`,
  });

  expect(docker.listContainers()).toStrictEqual([`${instance.container}-ts-member`]);
});

test('#stopTailscaleTailnet refuses a member that another instance’s harness started', () => {
  const docker = buildStubDockerRunner([
    { name: `${instance.container}-ts-member`, labels: { [MEMBER_OWNER_LABEL]: 'imp-e2e-b' } },
  ]);

  expect(stopTailscaleTailnet(docker)).rejects.toThrowWithMessage(
    Error,
    `${instance.container}-ts-member is not a tailnet member this harness started for ${instance.container}, so it stays: remove it or set another IMP_DEV_NAME`,
  );
});

test('#stopTailscaleTailnet passes when there is no member to remove', async () => {
  const docker = buildStubDockerRunner([{ name: instance.container }]);

  await stopTailscaleTailnet(docker);

  expect(docker.listContainers()).toStrictEqual([instance.container]);
});

test('#stopTailscaleTailnet fails with what docker said when the member is not removed', () => {
  const runCommand = mock<CommandRunners['runCommand']>(() =>
    Promise.resolve({ exitCode: 0, stdout: `${instance.container}\n`, stderr: '' }),
  );

  const runChecked = mock<CommandRunners['runChecked']>(() =>
    Promise.reject(
      new Error(
        'docker rm -f imp-e2e-a-ts-member exited 1: Error response from daemon: cannot remove container: device or resource busy',
      ),
    ),
  );

  expect(stopTailscaleTailnet({ runCommand, runChecked })).rejects.toThrowWithMessage(
    Error,
    'docker rm -f imp-e2e-a-ts-member exited 1: Error response from daemon: cannot remove container: device or resource busy',
  );
});
