import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createImpClient } from '../../packages/client/src/index';
import { createImage } from '../../packages/daemon/src/db/images';
import { buildImagePaths, buildMockNewImage, startTestImpd } from '../../packages/daemon/testing';
import {
  removeImageIfPresent,
  removeImpIfPresent,
  removeNetworkIfPresent,
  removeOAuthClientIfPresent,
  removeSecretIfPresent,
  removeTokenIfPresent,
  resetBaseline,
} from './reset-baseline';

// impd's real app on the stub VMM, as the dev instance runs it, with the
// in-process client the reset drives
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the bearer the test's client sends
  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  const dataDir = harness.dataDir;
  const sendClientRequest = (request: Request) => harness.impd.api.app.handle(request);

  const client = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    fetch: sendClientRequest,
  });

  // the image an imp boots from when it names none, as impd's image
  // service leaves it: its rootfs under its digest
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  const image = await createImage(
    harness.db,
    buildMockNewImage({ name: 'ubuntu', digest: 'sha256:ubuntu', sizeBytes: 6 }),
  );

  return { client, db: harness.db, dataDir, vmm: harness.fake, impd: harness.impd, image };
}

test('#resetBaseline removes the imps a journey named with its prefix, with their checkpoints and leases', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'e2e-x-dev' });
  const checkpoint = await ctx.client.checkpoints.create({ name: 'e2e-x-dev', label: 'cp1' });

  await ctx.client.leases.acquire({ name: 'e2e-x-dev', label: 'job', ttlSeconds: 120 });

  const checkpointDisk = join(
    ctx.dataDir,
    'imps',
    imp.id,
    'checkpoints',
    checkpoint.id,
    'disk.ext4',
  );

  const impsBefore = await ctx.client.imps.list();
  const leasesBefore = await ctx.client.leases.list({});

  const hadCheckpointDisk = existsSync(checkpointDisk);

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const imps = await ctx.client.imps.list();
  const leases = await ctx.client.leases.list({});

  expect(impsBefore.map((row) => row.name)).toStrictEqual(['e2e-x-dev']);
  expect(leasesBefore.map((lease) => lease.owner.label)).toStrictEqual(['job']);
  expect(hadCheckpointDisk).toBeTrue();
  expect(imps).toBeEmpty();
  expect(leases).toBeEmpty();
  expect(existsSync(checkpointDisk)).toBeFalse();
});

test('#resetBaseline removes the networks a journey named with its prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'e2e-x-lab' });

  const before = await ctx.client.networks.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.networks.list();

  expect(before.map((network) => network.name)).toStrictEqual(['e2e-x-lab']);
  expect(after).toBeEmpty();
});

test('#resetBaseline removes the secrets a journey named with its prefix, and their grants to other imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'e2e-x-gh', kind: 'github', value: 'ghp_e2e' });
  await ctx.client.grants.add({ name: 'dev', secret: 'e2e-x-gh' });

  const secretsBefore = await ctx.client.secrets.list();
  const grantsBefore = await ctx.client.grants.list({ name: 'dev' });

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const secrets = await ctx.client.secrets.list();
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(secretsBefore.map((secret) => secret.name)).toStrictEqual(['e2e-x-gh']);
  expect(grantsBefore).toStrictEqual(['e2e-x-gh']);
  expect(secrets).toBeEmpty();
  expect(grants).toBeEmpty();
});

test('#resetBaseline removes a prefixed imp together with the grants it holds', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_owner' });
  await ctx.client.grants.add({ name: 'e2e-x-dev', secret: 'gh' });

  const grantsBefore = await ctx.client.grants.list({ name: 'e2e-x-dev' });

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const secrets = await ctx.client.secrets.list();

  expect(grantsBefore).toStrictEqual(['gh']);
  expect(secrets.map((secret) => secret.imps)).toStrictEqual([[]]);
});

test('#resetBaseline removes the tokens a journey named with its prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'e2e-x-reader', scope: 'read' });

  const before = await ctx.client.tokens.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.tokens.list();

  expect(before.map((token) => token.name)).toStrictEqual(['e2e-x-reader']);
  expect(after).toBeEmpty();
});

test('#resetBaseline removes the OAuth clients a journey named with its prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.oauth.clients.add({
    name: 'e2e-x-conn',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
  });

  const before = await ctx.client.oauth.clients.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.oauth.clients.list();

  expect(before.map((client) => client.name)).toStrictEqual(['e2e-x-conn']);
  expect(after).toBeEmpty();
});

test('#resetBaseline removes the images a journey named with its prefix, after the imps that boot them', async () => {
  const ctx = await setupTest();

  const prefixedImage = buildMockNewImage({ name: 'e2e-x-img', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, prefixedImage.digest).rootfs, 'rootfs');

  await createImage(ctx.db, prefixedImage);

  await ctx.client.imps.create({ name: 'e2e-x-dev', image: 'e2e-x-img' });

  const before = await ctx.client.images.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.images.list();

  expect(before.map((image) => image.name)).toIncludeSameMembers([ctx.image.name, 'e2e-x-img']);
  expect(after.map((image) => image.name)).toStrictEqual([ctx.image.name]);
});

test('#resetBaseline removes the templates a journey made from its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.images.add({ imp: 'e2e-x-dev', name: 'e2e-x-golden' });

  const before = await ctx.client.images.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.images.list();

  expect(before.map((image) => image.name)).toIncludeSameMembers([ctx.image.name, 'e2e-x-golden']);
  expect(after.map((image) => image.name)).toStrictEqual([ctx.image.name]);
});

test('#resetBaseline removes the broker test upstreams file a journey wrote', async () => {
  const ctx = await setupTest();

  const upstreams = join(ctx.dataDir, 'broker-test-upstreams.json');

  await Bun.write(upstreams, '{"ca":"","upstreams":{}}');

  const hadUpstreams = existsSync(upstreams);

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  expect(hadUpstreams).toBeTrue();
  expect(existsSync(upstreams)).toBeFalse();
});

test('#resetBaseline removes what any of several prefixes names', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'e2e-x-lab' });
  await ctx.client.networks.create({ name: 'e2e-y-lab' });

  const before = await ctx.client.networks.list();

  await resetBaseline({
    client: ctx.client,
    prefixes: ['e2e-x-', 'e2e-y-'],
    dataDir: ctx.dataDir,
  });

  const after = await ctx.client.networks.list();

  expect(before.map((network) => network.name)).toIncludeSameMembers(['e2e-x-lab', 'e2e-y-lab']);
  expect(after).toBeEmpty();
});

test('#resetBaseline never removes what another owner named, a near-miss prefix included', async () => {
  const ctx = await setupTest();

  for (const name of ['e2e-tiny-0123abcd', 'e2e-xy-img']) {
    const image = buildMockNewImage({ name, sizeBytes: 6 });

    await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

    await createImage(ctx.db, image);
  }

  await ctx.client.imps.create({ name: 'e2e-y-dev', image: 'e2e-tiny-0123abcd' });
  await ctx.client.imps.create({ name: 'e2e-xy-dev' });
  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.networks.create({ name: 'e2e-xy-lab' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_owner' });
  await ctx.client.secrets.add({ name: 'e2e-xy-gh', kind: 'github', value: 'ghp_near' });
  await ctx.client.tokens.create({ name: 'reader', scope: 'read' });
  await ctx.client.tokens.create({ name: 'e2e-xy-reader', scope: 'read' });

  for (const name of ['conn', 'e2e-xy-conn']) {
    await ctx.client.oauth.clients.add({
      name,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    });
  }

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const imps = await ctx.client.imps.list();
  const images = await ctx.client.images.list();
  const networks = await ctx.client.networks.list();
  const secrets = await ctx.client.secrets.list();
  const tokens = await ctx.client.tokens.list();
  const clients = await ctx.client.oauth.clients.list();

  expect(imps.map((imp) => imp.name)).toIncludeSameMembers(['e2e-xy-dev', 'e2e-y-dev']);

  expect(images.map((image) => image.name)).toIncludeSameMembers([
    'e2e-tiny-0123abcd',
    'e2e-xy-img',
    ctx.image.name,
  ]);

  expect(networks.map((network) => network.name)).toIncludeSameMembers(['e2e-xy-lab', 'lab']);
  expect(secrets.map((secret) => secret.name)).toIncludeSameMembers(['e2e-xy-gh', 'gh']);
  expect(tokens.map((token) => token.name)).toIncludeSameMembers(['e2e-xy-reader', 'reader']);
  expect(clients.map((client) => client.name)).toIncludeSameMembers(['conn', 'e2e-xy-conn']);
});

test('#resetBaseline fails when impd refuses to remove what the prefix names', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'e2e-x-img', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev', image: 'e2e-x-img' });

  expect(
    resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('#resetBaseline ends the move of an imp a failed move left marked, then removes it', async () => {
  const ctx = await setupTest();

  // a move's first step counts the image's files too
  await Bun.write(join(ctx.dataDir, 'images', ctx.image.name, 'config.json'), '{}');
  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.imps.stop({ name: 'e2e-x-dev' });
  await ctx.client.moves.prepare({ name: 'e2e-x-dev', targetStorage: 'xfs' });

  const before = await ctx.client.imps.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.imps.list();

  expect(before.map((imp) => [imp.name, imp.move])).toStrictEqual([['e2e-x-dev', 'sending']]);
  expect(after).toBeEmpty();
});

test('#resetBaseline fails when the move of a marked imp cannot be ended', async () => {
  const ctx = await setupTest();

  // a move's first step counts the image's files too
  await Bun.write(join(ctx.dataDir, 'images', ctx.image.name, 'config.json'), '{}');

  const imp = await ctx.client.imps.create({ name: 'e2e-x-dev' });

  await ctx.client.imps.stop({ name: 'e2e-x-dev' });
  await ctx.client.moves.prepare({ name: 'e2e-x-dev', targetStorage: 'xfs' });

  // the send's target is one that nothing answers, so the abort cannot reach it
  await ctx.db
    .updateTable('move_sends')
    .set({ peer_url: 'http://127.0.0.1:1', ticket: 'ticket' })
    .where('imp_id', '=', imp.id)
    .execute();

  expect(
    resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir }),
  ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
});

test('#resetBaseline removes an imp that a failed boot left in error', async () => {
  const ctx = await setupTest();

  ctx.vmm.queue('boot', 'fail');

  const failure = await ctx.client.imps.create({ name: 'e2e-x-dev' }).then(
    () => null,
    (error: unknown) => error,
  );

  const before = await ctx.client.imps.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.imps.list();

  expect(failure).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(before.map((imp) => [imp.name, imp.state])).toStrictEqual([['e2e-x-dev', 'error']]);
  expect(after).toBeEmpty();
});

test('#removeImpIfPresent removes the imp it names', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });

  await removeImpIfPresent(ctx.client, 'e2e-x-dev');

  const imps = await ctx.client.imps.list();

  expect(imps).toBeEmpty();
});

test('#removeImpIfPresent passes over an imp that is already gone', async () => {
  const ctx = await setupTest();

  await expect(removeImpIfPresent(ctx.client, 'e2e-x-dev')).toResolve();
});

test('#removeImpIfPresent fails when impd refuses the removal', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });

  const sendStrangerRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: sendStrangerRequest,
  });

  expect(removeImpIfPresent(stranger, 'e2e-x-dev')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

test('#removeImageIfPresent removes the template it names', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.images.add({ imp: 'e2e-x-dev', name: 'e2e-x-golden' });

  await removeImageIfPresent(ctx.client, 'e2e-x-golden');

  const images = await ctx.client.images.list();

  expect(images.map((image) => image.name)).toStrictEqual([ctx.image.name]);
});

test('#removeImageIfPresent passes over an image that is already gone', async () => {
  const ctx = await setupTest();

  await expect(removeImageIfPresent(ctx.client, 'e2e-x-golden')).toResolve();
});

test('#removeImageIfPresent fails while an imp boots the image', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.images.add({ imp: 'e2e-x-dev', name: 'e2e-x-golden' });
  await ctx.client.imps.create({ name: 'e2e-x-copy', image: 'e2e-x-golden' });

  expect(removeImageIfPresent(ctx.client, 'e2e-x-golden')).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('#removeTokenIfPresent removes the token it names', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'e2e-x-reader', scope: 'read' });

  await removeTokenIfPresent(ctx.client, 'e2e-x-reader');

  const tokens = await ctx.client.tokens.list();

  expect(tokens).toBeEmpty();
});

test('#removeTokenIfPresent passes over a token that is already gone', async () => {
  const ctx = await setupTest();

  await expect(removeTokenIfPresent(ctx.client, 'e2e-x-reader')).toResolve();
});

test('#removeTokenIfPresent fails when impd refuses the removal', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'e2e-x-reader', scope: 'read' });

  const sendStrangerRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: sendStrangerRequest,
  });

  expect(removeTokenIfPresent(stranger, 'e2e-x-reader')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

test('#removeSecretIfPresent removes the secret it names, and its grants', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.secrets.add({ name: 'e2e-x-gh', kind: 'github', value: 'ghp_e2e' });
  await ctx.client.grants.add({ name: 'e2e-x-dev', secret: 'e2e-x-gh' });

  await removeSecretIfPresent(ctx.client, 'e2e-x-gh');

  const secrets = await ctx.client.secrets.list();
  const grants = await ctx.client.grants.list({ name: 'e2e-x-dev' });

  expect(secrets).toBeEmpty();
  expect(grants).toBeEmpty();
});

test('#removeSecretIfPresent passes over a secret that is already gone', async () => {
  const ctx = await setupTest();

  await expect(removeSecretIfPresent(ctx.client, 'e2e-x-gh')).toResolve();
});

test('#removeSecretIfPresent fails when impd refuses the removal', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'e2e-x-gh', kind: 'github', value: 'ghp_e2e' });

  const sendStrangerRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: sendStrangerRequest,
  });

  expect(removeSecretIfPresent(stranger, 'e2e-x-gh')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

test('#removeNetworkIfPresent removes the network it names', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'e2e-x-lab' });

  await removeNetworkIfPresent(ctx.client, 'e2e-x-lab');

  const networks = await ctx.client.networks.list();

  expect(networks).toBeEmpty();
});

test('#removeNetworkIfPresent passes over a network that is already gone', async () => {
  const ctx = await setupTest();

  await expect(removeNetworkIfPresent(ctx.client, 'e2e-x-lab')).toResolve();
});

test('#removeNetworkIfPresent fails when impd refuses the removal', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'e2e-x-lab' });

  const sendStrangerRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: sendStrangerRequest,
  });

  expect(removeNetworkIfPresent(stranger, 'e2e-x-lab')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

test('#removeOAuthClientIfPresent removes the OAuth client it names', async () => {
  const ctx = await setupTest();

  await ctx.client.oauth.clients.add({
    name: 'e2e-x-conn',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
  });

  await removeOAuthClientIfPresent(ctx.client, 'e2e-x-conn');

  const clients = await ctx.client.oauth.clients.list();

  expect(clients).toBeEmpty();
});

test('#removeOAuthClientIfPresent passes over an OAuth client that is already gone', async () => {
  const ctx = await setupTest();

  await expect(removeOAuthClientIfPresent(ctx.client, 'e2e-x-conn')).toResolve();
});

test('#removeOAuthClientIfPresent fails when impd refuses the removal', async () => {
  const ctx = await setupTest();

  await ctx.client.oauth.clients.add({
    name: 'e2e-x-conn',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
  });

  const sendStrangerRequest = (request: Request) => ctx.impd.api.app.handle(request);

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: sendStrangerRequest,
  });

  expect(removeOAuthClientIfPresent(stranger, 'e2e-x-conn')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});
