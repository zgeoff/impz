import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImage } from '@impz/daemon/src/platform/db/images';
import { findImpByName } from '@impz/daemon/src/platform/db/imps';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubCloudflareApi,
  startStubImpdRelease,
} from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { writeHostConfig } from '../config/host-store';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startImpdHost } from '../test-utils/start-impd-host';

// The CLI's home, where config.json keeps the saved hosts, so none of this
// machine's reaches it; each impd host a test starts releases into `stack`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-imps-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { home: { HOME: dir, XDG_CONFIG_HOME: dir }, stack };
}

test('#new refuses a size that is not a whole positive number', async () => {
  const result = await runCLIInProcess({
    args: ['new', 'box', '--memory', '1.5g'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: not a size: 1.5g (try 512m, 2g, 1t, or MiB as a whole number)\n',
    code: 2,
  });
});

test('#new refuses an IMP_URL that is not an http URL', async () => {
  const result = await runCLIInProcess({
    args: ['new', 'box'],
    env: { IMP_URL: 'localhost:7070' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: IMP_URL is not an http(s) URL: localhost:7070\n',
    code: 2,
  });
});

test('#new refuses --auth without --public before any call to impd', async () => {
  // nothing listens there: a call would fail on the connection instead
  const result = await runCLIInProcess({
    args: ['new', 'box', '--auth', 'basic'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --auth and --user need --public\n',
    code: 2,
  });
});

test('#new refuses --public for a token limited to some imps, and creates nothing', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const limited = await box.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev*'],
  });

  const result = await runCLIInProcess({
    args: ['new', 'dev', '--public'],
    env: { ...ctx.home, IMP_URL: box.url, IMP_TOKEN: limited.secret },
  });

  const dev = await findImpByName(box.db, 'dev');

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --public needs a token with manage scope on the host; this one is limited\n',
    code: 1,
  });

  expect(dev).toBeUndefined();
});

test('#new creates an imp left out of every backup for --no-backup', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const result = await runCLIInProcess({
    args: ['new', 'chat', '--image', 'base', '--no-backup', '--json'],
    env: { ...ctx.home, IMP_URL: box.url, IMP_TOKEN: box.rootToken },
  });

  const chat = await findImpByName(box.db, 'chat');

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ name: 'chat', backup: false });
  expect(chat?.isBackedUp).toBe(false);
});

test('#new refuses --no-backup on an impd from before the setting, and creates nothing', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const older = startStubImpdRelease(ctx.stack, box.sendRequest, {
    withoutFeatures: ['backupOptOut'],
  });

  const result = await runCLIInProcess({
    args: ['new', 'chat', '--image', 'base', '--no-backup'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: box.rootToken },
  });

  const chat = await findImpByName(box.db, 'chat');

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no backup opt-out and would back the imp up anyway; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(chat).toBeUndefined();
});

test('#new refuses --place with --host', async () => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: 'http://127.0.0.1:1', token: 'imps-token' } },
  });

  const placed = await runCLIInProcess({
    args: ['--host', 'box', 'new', 'dev', '--place'],
    env: ctx.home,
  });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'impz: --place picks among the saved hosts; drop --host\n',
    code: 2,
  });
});

test('#new skips a host without the image and moves past a RAM refusal under --place', async () => {
  const ctx = await setupTest();
  const big = await startImpdHost(ctx.stack, { env: { IMP_KSM: '1' } });
  const small = await startImpdHost(ctx.stack, { env: {} });
  const bare = await startImpdHost(ctx.stack, { env: {} });

  // big: the most free RAM by system.info, but a held imp whose KSM saving
  // the governor keeps free leaves no room for a boot
  const bigImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(big.dataDir, bigImage.digest).rootfs, 'rootfs');

  await createImage(big.db, bigImage);

  await big.client.imps.create({ name: 'held' });
  await big.client.leases.acquire({ name: 'held', label: 'work', ttlSeconds: 3600 });

  big.ksm.profitMib = 16_000;

  // small: two awake imps, so less free RAM than big
  const smallImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(small.dataDir, smallImage.digest).rootfs, 'rootfs');

  await createImage(small.db, smallImage);

  await small.client.imps.create({ name: 'web' });
  await small.client.imps.create({ name: 'db' });

  // bare: the most free RAM of all, but not the image asked for
  const bareImage = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(bare.dataDir, bareImage.digest).rootfs, 'rootfs');

  await createImage(bare.db, bareImage);

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: big.rootToken },
      small: { url: small.url, token: small.rootToken },
      bare: { url: bare.url, token: bare.rootToken },
    },
  });

  const placed = await runCLIInProcess({
    args: ['new', 'dev', '--image', 'base', '--place', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  const created = await small.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify({ host: 'small', imp: created }));

  expect(placed.stderr).toBe(
    [
      'impz: bare: skipped: it has no image base',
      'impz: placing on big',
      'impz: big: not enough RAM: 17024 of 16384 MiB in use, 1024 MiB requested, and no idle imp left to sleep; trying the next host',
      'impz: placing on small',
      '',
    ].join('\n'),
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(0);

  const bigDev = await findImpByName(big.db, 'dev');

  expect(bigDev).toBeUndefined();

  const bareDev = await findImpByName(bare.db, 'dev');

  expect(bareDev).toBeUndefined();
});

test('#new places on a reachable host under --place when another saved host does not answer', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  // nothing listens at gone's address
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const placed = await runCLIInProcess({
    args: ['new', 'dev', '--image', 'base', '--place', '--json'],
    env: ctx.home,
  });

  const created = await box.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify({ host: 'box', imp: created }));

  expect({ ...placed, stdout: JSON.parse(placed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: [
      'impz: gone: skipped: Unable to connect. Is the computer able to access the url?',
      'impz: placing on box',
      '',
    ].join('\n'),
    code: 0,
  });
});

test('#new refuses --place when no saved host can take the imp', async () => {
  const ctx = await setupTest();
  const bare = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // bare has an image, but not the one asked for
  await Bun.write(buildImagePaths(bare.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(bare.db, image);

  writeHostConfig(ctx.home, {
    current: 'bare',
    hosts: { bare: { url: bare.url, token: bare.rootToken } },
  });

  const placed = await runCLIInProcess({
    args: ['new', 'dev', '--image', 'base', '--place'],
    env: ctx.home,
  });

  const dev = await findImpByName(bare.db, 'dev');

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'impz: bare: skipped: it has no image base\nimpz: no saved host can take the imp\n',
    code: 1,
  });

  expect(dev).toBeUndefined();
});

test('#new refuses --place for a name a saved host has already', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  const boxImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, boxImage.digest).rootfs, 'rootfs');

  await createImage(box.db, boxImage);

  await box.client.imps.create({ name: 'web' });

  const laptopImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(laptop.dataDir, laptopImage.digest).rootfs, 'rootfs');

  await createImage(laptop.db, laptopImage);

  await laptop.client.imps.create({ name: 'dev' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
    },
  });

  const placed = await runCLIInProcess({ args: ['new', 'dev', '--place'], env: ctx.home });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'impz: dev exists on laptop already; pick another name\n',
    code: 1,
  });

  const boxDev = await findImpByName(box.db, 'dev');

  expect(boxDev).toBeUndefined();
});

test('#new passes over a host whose token is limited, then exposes, under --place --public', async () => {
  const ctx = await setupTest();
  const big = await startImpdHost(ctx.stack, { env: {} });

  // Cloudflare, where impd's startup and the expose write the records
  const cloudflare = buildStubCloudflareApi({ tokens: ['unused'] });

  await cloudflare.zones.create({ name: 'imp.example.com' });

  server.use(...cloudflare.handlers);

  // a domain and a public address, so imps.expose works
  const small = await startImpdHost(ctx.stack, {
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  const bigImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(big.dataDir, bigImage.digest).rootfs, 'rootfs');

  await createImage(big.db, bigImage);

  // big's saved token reaches only some imps
  const limited = await big.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev*'],
  });

  const smallImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(small.dataDir, smallImage.digest).rootfs, 'rootfs');

  await createImage(small.db, smallImage);

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: limited.secret },
      small: { url: small.url, token: small.rootToken },
    },
  });

  const placed = await runCLIInProcess({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  // the create's answer, from before the expose
  const { public: _exposed, ...created } = await small.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const imp: unknown = JSON.parse(JSON.stringify(created));

  expect(placed.stderr).toBe(
    [
      'impz: big: skipped: its token is limited to some imps, which --public and --net need it not to be',
      'impz: placing on small',
      '',
    ].join('\n'),
  );

  expect(body).toStrictEqual({
    host: 'small',
    imp,
    public: {
      url: 'https://dev.imp.example.com',
      auth: 'token',
      user: null,
      credential: expect.any(String) as unknown,
    },
  });

  expect(placed.code).toBe(0);

  const bigDev = await findImpByName(big.db, 'dev');

  expect(bigDev).toBeUndefined();
});

test('#new names the host of a failure after a placed create, and still writes the imp', async () => {
  const ctx = await setupTest();

  // box has no IMP_PUBLIC_IP, so its expose fails
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const placed = await runCLIInProcess({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  const created = await box.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify({
      host: 'box',
      imp: created,
      error: 'PRECONDITION_FAILED: public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host',
    }),
  );

  expect(placed.stderr).toBe(
    'impz: placing on box\nimpz: dev was created on box; PRECONDITION_FAILED: public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host\n',
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(1);
});
