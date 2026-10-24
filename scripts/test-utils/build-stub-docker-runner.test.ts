import { expect, test } from 'bun:test';
import { buildStubDockerRunner } from './build-stub-docker-runner';

test('it removes the named container and prints its name, as docker rm -f does', async () => {
  const docker = buildStubDockerRunner([{ name: 'imp-e2e-a-ts-member' }, { name: 'imp-e2e-a' }]);

  const stdout = await docker.runChecked(['docker', 'rm', '-f', 'imp-e2e-a-ts-member']);

  expect(stdout).toBe('imp-e2e-a-ts-member\n');
  expect(docker.listContainers()).toStrictEqual(['imp-e2e-a']);
});

test('it passes over a missing container with no output, as docker rm -f does', async () => {
  const docker = buildStubDockerRunner([{ name: 'imp-e2e-a' }]);

  const stdout = await docker.runChecked(['docker', 'rm', '-f', 'imp-e2e-b-ts-member']);

  expect(stdout).toBe('');
  expect(docker.listContainers()).toStrictEqual(['imp-e2e-a']);
});

test('it refuses a docker command other than rm -f', () => {
  const docker = buildStubDockerRunner([{ name: 'imp-e2e-a' }]);

  expect(docker.runChecked(['docker', 'rm', 'imp-e2e-a'])).rejects.toThrowWithMessage(
    Error,
    'docker rm imp-e2e-a: the stub runs only docker rm -f',
  );
});

test('it prints a container’s label for an inspect of that label', async () => {
  const docker = buildStubDockerRunner([
    { name: 'imp-e2e-a-ts-member', labels: { 'example.owner': 'imp-e2e-a' } },
  ]);

  const result = await docker.runCommand([
    'docker',
    'inspect',
    '--format',
    '{{index .Config.Labels "example.owner"}}',
    'imp-e2e-a-ts-member',
  ]);

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'imp-e2e-a\n', stderr: '' });
});

test('it prints an empty line for a label the container lacks, as docker inspect does', async () => {
  const docker = buildStubDockerRunner([{ name: 'imp-e2e-a-ts-member' }]);

  const result = await docker.runCommand([
    'docker',
    'inspect',
    '--format',
    '{{index .Config.Labels "example.owner"}}',
    'imp-e2e-a-ts-member',
  ]);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '\n', stderr: '' });
});

test('it fails an inspect of a missing container with docker’s no-such-object error', async () => {
  const docker = buildStubDockerRunner([]);

  const result = await docker.runCommand([
    'docker',
    'inspect',
    '--format',
    '{{index .Config.Labels "example.owner"}}',
    'imp-e2e-a-ts-member',
  ]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'error: no such object: imp-e2e-a-ts-member\n',
  });
});

test('it refuses an inspect with a format other than one label', () => {
  const docker = buildStubDockerRunner([{ name: 'imp-e2e-a' }]);

  expect(
    docker.runCommand(['docker', 'inspect', '--format', '{{.State.Status}}', 'imp-e2e-a']),
  ).rejects.toThrowWithMessage(
    Error,
    'docker inspect --format {{.State.Status}} imp-e2e-a: the stub runs only docker inspect of one label',
  );
});
