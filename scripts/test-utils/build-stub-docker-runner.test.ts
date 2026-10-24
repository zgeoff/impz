import { expect, test } from 'bun:test';
import { buildStubDockerRunner } from './build-stub-docker-runner';

test('it removes the named container and prints its name, as docker rm -f does', async () => {
  const docker = buildStubDockerRunner(['imp-e2e-a-ts-member', 'imp-e2e-a']);

  const stdout = await docker.runChecked(['docker', 'rm', '-f', 'imp-e2e-a-ts-member']);

  expect(stdout).toBe('imp-e2e-a-ts-member\n');
  expect(docker.listContainers()).toStrictEqual(['imp-e2e-a']);
});

test('it passes over a missing container with no output, as docker rm -f does', async () => {
  const docker = buildStubDockerRunner(['imp-e2e-a']);

  const stdout = await docker.runChecked(['docker', 'rm', '-f', 'imp-e2e-b-ts-member']);

  expect(stdout).toBe('');
  expect(docker.listContainers()).toStrictEqual(['imp-e2e-a']);
});

test('it refuses a docker command other than rm -f', () => {
  const docker = buildStubDockerRunner(['imp-e2e-a']);

  expect(docker.runChecked(['docker', 'rm', 'imp-e2e-a'])).rejects.toThrowWithMessage(
    Error,
    'docker rm imp-e2e-a: the stub runs only docker rm -f',
  );
});
