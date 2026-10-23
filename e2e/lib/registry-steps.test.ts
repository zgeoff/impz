import { expect, onTestFinished, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { instance } from './instance';
import {
  collectUnpinnedRequests,
  createMovedTag,
  getRepoDigest,
  parseManifestRequests,
  removeStaleRegistries,
  startRegistry,
} from './registry-steps';

async function setupTest() {
  const cleanup = new AsyncDisposableStack();

  onTestFinished(() => cleanup.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'registry-steps-'));

  cleanup.defer(() => rm(directory, { recursive: true, force: true }));

  const stack = new AsyncDisposableStack();

  cleanup.defer(() => stack.disposeAsync());

  return { stack, directoryPath: directory };
}

test('#parseManifestRequests reads the repository’s manifest references in order', () => {
  const logs = [
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/manifests/1"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/other/manifests/1"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/manifests/sha256:abc"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/blobs/sha256:def"',
  ].join('\n');

  expect(parseManifestRequests(logs, 'e2e/mutable')).toStrictEqual(['1', 'sha256:abc']);
});

test('#getRepoDigest picks the digest under the repository', () => {
  const digests = JSON.stringify(['mirror.test/busybox@sha256:aaa', 'busybox@sha256:bbb']);

  expect(getRepoDigest(digests, 'busybox')).toBe('busybox@sha256:bbb');
});

test('#getRepoDigest fails when no digest is under the repository', () => {
  expect(() => getRepoDigest('["mirror.test/busybox@sha256:aaa"]', 'busybox')).toThrowWithMessage(
    Error,
    'no RepoDigest under busybox in ["mirror.test/busybox@sha256:aaa"]',
  );
});

test('#collectUnpinnedRequests keeps every reference but the pin’s digest', () => {
  expect(
    collectUnpinnedRequests('reg.test:5000/e2e/mutable@sha256:abc', [
      'sha256:abc',
      '1',
      'sha256:abc',
    ]),
  ).toStrictEqual(['1']);
});

test("#startRegistry runs a registry labelled with the instance on its network's gateway, on a certificate for its name", async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    ['case "$1 $2" in', '  "container inspect"|"network inspect") exit 1 ;;', 'esac'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const certs = join(ctx.directoryPath, 'registry-tls');

  const registry = await startRegistry(
    ctx.stack,
    {
      name: 'imp-e2e-registry.test',
      port: 15_443,
      certDirectory: certs,
      network: 'imp-dev-registry',
      subnet: '10.200.0.0/24',
      gateway: '10.200.0.1',
    },
    'e2e-reg-registry-1',
  );

  const calls = await readFile(docker.calls, 'utf8');
  const pem = await readFile(join(certs, 'cert.pem'));

  const cert = new X509Certificate(pem);

  expect(registry).toStrictEqual({
    address: 'imp-e2e-registry.test:15443',
    container: 'e2e-reg-registry-1',
    certPath: join(certs, 'cert.pem'),
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect e2e-reg-registry-1',
    'docker network inspect imp-dev-registry --format {{index .Labels "imp-e2e-instance"}}',
    `docker network create --label imp-e2e-instance=${instance.container} --subnet 10.200.0.0/24 --gateway 10.200.0.1 imp-dev-registry`,
    `docker run --detach --name e2e-reg-registry-1 --label imp-e2e-instance=${instance.container} --network host --volume ${certs}:/certs:ro --env REGISTRY_HTTP_ADDR=10.200.0.1:15443 --env REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem --env REGISTRY_HTTP_TLS_KEY=/certs/key.pem registry:2`,
    '',
  ]);

  expect(cert.subjectAltName).toBe('DNS:imp-e2e-registry.test');
});

test('#startRegistry removes the network a stopped run of this instance left, before it makes its own', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$1 $2" in',
      '  "container inspect") exit 1 ;;',
      `  "network inspect") echo ${instance.container} ;;`,
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await startRegistry(
    ctx.stack,
    {
      name: 'imp-e2e-registry.test',
      port: 15_443,
      certDirectory: join(ctx.directoryPath, 'registry-tls'),
      network: 'imp-dev-registry',
      subnet: '10.200.0.0/24',
      gateway: '10.200.0.1',
    },
    'e2e-reg-registry-1',
  );

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n').slice(1, 4)).toStrictEqual([
    'docker network inspect imp-dev-registry --format {{index .Labels "imp-e2e-instance"}}',
    'docker network rm imp-dev-registry',
    `docker network create --label imp-e2e-instance=${instance.container} --subnet 10.200.0.0/24 --gateway 10.200.0.1 imp-dev-registry`,
  ]);
});

test('#startRegistry never removes a network this instance did not label', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$1 $2" in',
      '  "container inspect") exit 1 ;;',
      '  "network inspect") echo imp-dev-other ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const failure = await startRegistry(
    ctx.stack,
    {
      name: 'imp-e2e-registry.test',
      port: 15_443,
      certDirectory: join(ctx.directoryPath, 'registry-tls'),
      network: 'imp-dev-registry',
      subnet: '10.200.0.0/24',
      gateway: '10.200.0.1',
    },
    'e2e-reg-registry-1',
  ).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(failure).toMatchObject({
    message: 'a network named imp-dev-registry is there, and this instance did not label it',
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect e2e-reg-registry-1',
    'docker network inspect imp-dev-registry --format {{index .Labels "imp-e2e-instance"}}',
    '',
  ]);
});

test('#startRegistry removes the registry it ran, its certificates and its network once the stack goes', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    ['case "$1 $2" in', '  "container inspect"|"network inspect") exit 1 ;;', 'esac'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const certs = join(ctx.directoryPath, 'registry-tls');

  await startRegistry(
    ctx.stack,
    {
      name: 'imp-e2e-registry.test',
      port: 15_443,
      certDirectory: certs,
      network: 'imp-dev-registry',
      subnet: '10.200.0.0/24',
      gateway: '10.200.0.1',
    },
    'e2e-reg-registry-1',
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n').slice(-3)).toStrictEqual([
    'docker rm --force --volumes e2e-reg-registry-1',
    'docker network rm imp-dev-registry',
    '',
  ]);

  expect(existsSync(certs)).toBeFalse();
});

test('#startRegistry refuses a container name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(ctx.directoryPath, 'docker', 'exit 0');

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const certs = join(ctx.directoryPath, 'registry-tls');

  const failure = await startRegistry(
    ctx.stack,
    {
      name: 'imp-e2e-registry.test',
      port: 15_443,
      certDirectory: certs,
      network: 'imp-dev-registry',
      subnet: '10.200.0.0/24',
      gateway: '10.200.0.1',
    },
    'e2e-reg-registry-1',
  ).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(failure).toMatchObject({
    message: 'a container named e2e-reg-registry-1 is already there',
  });

  expect(calls).toBe('docker container inspect e2e-reg-registry-1\n');
  expect(existsSync(certs)).toBeFalse();
});

test('#startRegistry removes no container when the registry does not start', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$1 $2" in',
      '  "container inspect"|"network inspect"|"run --detach") exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const failure = await startRegistry(
    ctx.stack,
    {
      name: 'imp-e2e-registry.test',
      port: 15_443,
      certDirectory: join(ctx.directoryPath, 'registry-tls'),
      network: 'imp-dev-registry',
      subnet: '10.200.0.0/24',
      gateway: '10.200.0.1',
    },
    'e2e-reg-registry-1',
  ).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(failure).toBeInstanceOf(Error);
  expect(calls.split('\n')).toSatisfyAll((line: string) => !line.startsWith('docker rm '));
});

test('#removeStaleRegistries never removes a registry container this instance did not label', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$*" in',
      '  *label=*) echo e2e-reg-registry-1 ;;',
      String.raw`  ps*) printf 'e2e-reg-registry-1\ne2e-reg-registry-2\n' ;;`,
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const swept = await removeStaleRegistries('e2e-reg-');
  const calls = await readFile(docker.calls, 'utf8');

  expect(swept).toStrictEqual({ removed: ['e2e-reg-registry-1'], left: ['e2e-reg-registry-2'] });

  expect(calls.split('\n')).toStrictEqual([
    'docker ps --all --format {{.Names}} --filter name=^e2e-reg-registry-',
    `docker ps --all --format {{.Names}} --filter name=^e2e-reg-registry- --filter label=imp-e2e-instance=${instance.container}`,
    'docker rm --force --volumes e2e-reg-registry-1',
    '',
  ]);
});

test('#createMovedTag moves the tag to new content and pins the old, and removes both tags with the stack', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$*" in',
      `  'image inspect --format {{json .RepoDigests}} busybox:1.37') echo '["busybox@sha256:aaa"]' ;;`,
      `  'image inspect --format {{json .RepoDigests}} sha256:new') echo '["imp-e2e-registry.test:49153/e2e/mutable@sha256:ccc"]' ;;`,
      `  'image inspect'*) echo '["imp-e2e-registry.test:49153/e2e/mutable@sha256:bbb"]' ;;`,
      `  build*mutable-new) echo sha256:new ;;`,
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const registry = {
    address: 'imp-e2e-registry.test:49153',
    container: 'e2e-reg-registry-1',
    certPath: join(ctx.directoryPath, 'cert.pem'),
  };

  const moved = await createMovedTag(ctx.stack, registry, ctx.directoryPath, 'e2e/mutable');

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  const tag = 'imp-e2e-registry.test:49153/e2e/mutable:1';
  const kept = 'imp-e2e-registry.test:49153/e2e/mutable:kept';

  expect(moved).toStrictEqual({
    tag,
    kept,
    pinned: 'imp-e2e-registry.test:49153/e2e/mutable@sha256:bbb',
    current: 'imp-e2e-registry.test:49153/e2e/mutable@sha256:ccc',
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker pull --quiet busybox:1.37',
    'docker image inspect --format {{json .RepoDigests}} busybox:1.37',
    `docker build --quiet --provenance=false --sbom=false --tag ${tag} ${join(ctx.directoryPath, 'e2e', 'mutable-old')}`,
    `docker push --quiet ${tag}`,
    `docker tag ${tag} ${kept}`,
    `docker image inspect --format {{json .RepoDigests}} ${tag}`,
    `docker build --quiet --provenance=false --sbom=false --tag ${tag} ${join(ctx.directoryPath, 'e2e', 'mutable-new')}`,
    `docker push --quiet ${tag}`,
    'docker image inspect --format {{json .RepoDigests}} sha256:new',
    `docker tag ${kept} ${tag}`,
    `docker rmi ${kept}`,
    `docker rmi ${tag}`,
    '',
  ]);
});

test('#createMovedTag removes the tag it made when a later step fails', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.directoryPath,
    'docker',
    [
      'case "$*" in',
      `  'image inspect'*) echo '["busybox@sha256:aaa"]' ;;`,
      '  tag*) exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const registry = {
    address: 'imp-e2e-registry.test:49153',
    container: 'e2e-reg-registry-1',
    certPath: join(ctx.directoryPath, 'cert.pem'),
  };

  const failure = await createMovedTag(ctx.stack, registry, ctx.directoryPath, 'e2e/mutable').then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(failure).toBeInstanceOf(Error);

  expect(calls.split('\n').filter((line) => line.startsWith('docker rmi '))).toStrictEqual([
    'docker rmi imp-e2e-registry.test:49153/e2e/mutable:1',
  ]);
});
