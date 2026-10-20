import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImage } from '@impz/daemon/src/platform/db/images';
import { createImp, readImpByName, updateImpMove } from '@impz/daemon/src/platform/db/imps';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  buildMockNewImp,
  startStubImpdRelease,
  startStubInnerAgent,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { writeHostConfig } from '../config/host-store';
import { buildStubTimeouts } from '../test-utils/build-stub-timeouts';
import { readJsonOutput } from '../test-utils/read-json-output';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startImpdHost } from '../test-utils/start-impd-host';
import { startStubSilentHost } from '../test-utils/start-stub-silent-host';
import { listAllImps, listForkWarnings, pickConsoleSession } from './imps-command';

// The CLI's home, where config.json keeps the saved hosts, so none of this
// machine's reaches it; each impd host a test starts releases into `stack`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-cli-imps-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { home: { HOME: directory, XDG_CONFIG_HOME: directory }, stack };
}

test('#listForkWarnings names each grant the fork did not get', () => {
  const fork = {
    name: 'dev-b',
    grantsNotCopied: [
      { secret: 'gh', reason: 'not-grantable' as const },
      { secret: 'npm', reason: 'clash' as const },
    ],
  };

  expect(listForkWarnings('dev-a', fork)).toStrictEqual([
    'dev-b: grant gh of dev-a not copied: not-grantable',
    'dev-b: grant npm of dev-a not copied: clash',
  ]);
});

test('#listForkWarnings names a copy of the grants that failed as a whole', () => {
  const fork = { name: 'dev-b', grantsNotCopied: [], grantsError: 'the copy failed' };

  expect(listForkWarnings('dev-a', fork)).toStrictEqual(['dev-b: the copy failed']);
});

test('#listForkWarnings warns of nothing for a fork from an impd that predates the report', () => {
  expect(listForkWarnings('dev-a', { name: 'dev-b' })).toBeEmpty();
});

test('#console refuses a detach key that is not ctrl-<key>', async () => {
  const result = await runCLIInProcess({
    args: ['console', 'box', '--detach-key', 'esc'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: String.raw`impz: --detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \, ], ^ or _) or none, got esc
`,
    code: 2,
  });
});

test('#console refuses an empty session name', async () => {
  const result = await runCLIInProcess({
    args: ['console', 'box', '--session', ''],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'impz: a session needs a name\n', code: 2 });
});

test.each([
  ['no session on a terminal', {}, true, 'main'],
  ['no session off a terminal', {}, false, null],
  ['a named session off a terminal', { session: 'work' }, false, 'work'],
  ['--no-session on a terminal', { 'no-session': true }, true, null],
] as const)(
  '#pickConsoleSession picks the console session for %s',
  (_case, args, isTerminal, expected) => {
    expect(pickConsoleSession(args, isTerminal)).toBe(expected);
  },
);

test.each([
  [
    ['exec', 'box', '--require', 'network', '--', 'true'],
    'impz: --require takes broker; not network\n',
  ],
  [
    ['exec', 'box', '--agent', '--require', 'broker', '--', 'true'],
    'impz: --require does not go with --agent\n',
  ],
])('#exec refuses %p before any call to impd', async (args, stderr) => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  const result = await runCLIInProcess({
    args,
    env: { ...ctx.home, IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test('#console refuses --log without a session before any call to impd', async () => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  const result = await runCLIInProcess({
    args: ['console', 'dev', '--no-session', '--log'],
    env: { ...ctx.home, IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'impz: --log needs a session\n', code: 2 });
});

test('#console makes no call past the feature check for --log on an impd from before session logs', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const older = startStubImpdRelease(ctx.stack, box.sendRequest, {
    withoutFeatures: ['sessionLog'],
  });

  const result = await runCLIInProcess({
    args: ['console', 'dev', '--session', 'main', '--log'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: box.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no session logs and would start the session without a log; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/features']);
});

test('#ls lists every saved host and exits 3 when one of them fails', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  const boxImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, boxImage.digest).rootfs, 'rootfs');

  await createImage(box.db, boxImage);

  await box.client.imps.create({ name: 'web' });
  await box.client.imps.create({ name: 'db' });

  // db is on its way to another host
  const db = await readImpByName(box.db, 'db');

  invariant(db);

  await updateImpMove(box.db, db.id, 'sending');

  const laptopImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(laptop.dataDir, laptopImage.digest).rootfs, 'rootfs');

  await createImage(laptop.db, laptopImage);

  await laptop.client.imps.create({ name: 'dev' });
  await laptop.client.imps.sleep({ name: 'dev' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--all'], env: ctx.home });

  const rows = listed.stdout.trimEnd().split('\n');

  expect(rows.map((row) => row.split(/\s+/u).slice(0, 3))).toStrictEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'db', 'running'],
    ['box', 'web', 'running'],
    ['laptop', 'dev', 'sleeping'],
  ]);

  expect(rows[1]).toEndWith('  sending');
  expect(listed.stderr).toMatch(/^impz: gone: [^\n]+\n$/u);
  expect(listed.code).toBe(3);
});

test('#listAllImps gives up on a host that never answers once its timer runs out', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  // takes the connection and never answers, as a sleeping laptop's impd
  // does from behind a stalled tailnet path
  const silent = startStubSilentHost(ctx.stack);

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      silent: { url: silent.url, token: 'silent-token' },
    },
  });

  const timeouts = buildStubTimeouts();
  const print = mock<(line: string) => void>();
  const printError = mock<(line: string) => void>();

  const listing = listAllImps({
    env: ctx.home,
    isJson: false,
    hasBuilders: false,
    print,
    printError,
    startTimer: timeouts.startTimer,
  });

  // box answered, so only the silent host's timer still runs; the hosts go
  // in name order
  await waitFor(() => {
    expect(timeouts.timers.map((timer) => timer.state)).toStrictEqual(['cancelled', 'pending']);
  });

  timeouts.firePending();

  const code = await listing;

  const table = print.mock.calls[0]?.[0];

  invariant(table !== undefined);

  expect(
    table
      .trimEnd()
      .split('\n')
      .map((row) => row.split(/\s+/u).slice(0, 3)),
  ).toStrictEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'web', 'running'],
  ]);

  expect(timeouts.timers.map((timer) => timer.durationMs)).toStrictEqual([5000, 5000]);
  expect(silent.requests).toStrictEqual(['/rpc/imps/list']);
  expect(printError).toHaveBeenCalledExactlyOnceWith('impz: silent: no answer in 5 s');
  expect(code).toBe(3);
});

test('#ls never prints a saved token under --all', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--all'], env: ctx.home });

  const printed = `${listed.stdout}${listed.stderr}`;

  expect(printed).not.toInclude(box.rootToken);
  expect(printed).not.toInclude('gone-token');
});

test('#ls writes the imps and the errors of every host as JSON for --all --json', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  const boxImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, boxImage.digest).rootfs, 'rootfs');

  await createImage(box.db, boxImage);

  await box.client.imps.create({ name: 'web' });
  await box.client.imps.create({ name: 'db' });

  const laptopImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(laptop.dataDir, laptopImage.digest).rootfs, 'rootfs');

  await createImage(laptop.db, laptopImage);

  await laptop.client.imps.create({ name: 'dev' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  const boxImps = await box.client.imps.list();
  const laptopImps = await laptop.client.imps.list();

  // what the CLI received, dates as JSON writes them, with each imp's host
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify([
      ...boxImps.map((imp) => Object.assign(imp, { host: 'box' })),
      ...laptopImps.map((imp) => Object.assign(imp, { host: 'laptop' })),
    ]),
  );

  expect(body).toStrictEqual({
    imps: sent,
    errors: [{ host: 'gone', message: expect.any(String) as unknown }],
  });

  expect(listed.code).toBe(3);
});

test('#ls writes an empty JSON list and exits 1 when no host answers --all --json', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.home, {
    current: 'gone',
    hosts: {
      gone: { url: 'http://127.0.0.1:1', token: 'imps-token' },
      away: { url: 'http://127.0.0.1:2', token: 'imps-token' },
    },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  expect(body).toStrictEqual({
    imps: [],
    errors: [
      { host: 'away', message: expect.any(String) as unknown },
      { host: 'gone', message: expect.any(String) as unknown },
    ],
  });

  const failed: unknown = listed.stderr.trimEnd().split('\n');

  expect(failed).toStrictEqual([
    expect.stringMatching(/^impz: away: /u) as unknown,
    expect.stringMatching(/^impz: gone: /u) as unknown,
  ]);

  expect(listed.code).toBe(1);
});

test('#ls lists every host’s builders under --all --builders', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  // a builder imp on each host, as a host build leaves one
  const boxImage = await createImage(box.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    box.db,
    buildMockNewImp({ name: 'box-builder', imageId: boxImage.id, kind: 'builder' }),
  );

  const laptopImage = await createImage(laptop.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    laptop.db,
    buildMockNewImp({ name: 'laptop-builder', imageId: laptopImage.id, kind: 'builder' }),
  );

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
    },
  });

  const listed = await runCLIInProcess({
    args: ['ls', '--all', '--builders', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(listed.stdout);

  const boxBuilder = await box.client.imps.get({ name: 'box-builder' });
  const laptopBuilder = await laptop.client.imps.get({ name: 'laptop-builder' });

  // what the CLI received, dates as JSON writes them, with each imp's host
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify([
      { ...boxBuilder, host: 'box' },
      { ...laptopBuilder, host: 'laptop' },
    ]),
  );

  expect(body).toStrictEqual({ imps: sent, errors: [] });
});

test('#ls lists no builder under plain --all', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  // a builder imp on each host, as a host build leaves one
  const boxImage = await createImage(box.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    box.db,
    buildMockNewImp({ name: 'box-builder', imageId: boxImage.id, kind: 'builder' }),
  );

  const laptopImage = await createImage(laptop.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    laptop.db,
    buildMockNewImp({ name: 'laptop-builder', imageId: laptopImage.id, kind: 'builder' }),
  );

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
    },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  expect(body).toStrictEqual({ imps: [], errors: [] });
});

test('#ls refuses --all with --host', async () => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: 'http://127.0.0.1:1', token: 'imps-token' } },
  });

  const listed = await runCLIInProcess({ args: ['--host', 'box', 'ls', '--all'], env: ctx.home });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'impz: --all lists every saved host; drop --host\n',
    code: 2,
  });
});

test('#ls lists the current host alone without --all', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  // nothing listens at laptop's URL: asking it would print its error
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: 'http://127.0.0.1:1', token: 'laptop-token' },
    },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify(imps));

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: '',
    code: 0,
  });
});

test('#ls prints --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--json'], env: ctx.home });

  expect(listed.code).toBe(0);
  expect(readJsonOutput('ls', listed.stdout).data).toStrictEqual(JSON.parse(listed.stdout));
});

test('#ls marks an awake imp whose inner container is down', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const imp = await box.client.imps.create({ name: 'web' });

  // its agent answers, with the container down after three restarts
  await startStubInnerAgent(buildImpPaths(box.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
    stack: ctx.stack,
  });

  await box.runIdleCheck();

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const listed = await runCLIInProcess({ args: ['ls'], env: ctx.home });

  const row = listed.stdout.split('\n').find((line) => line.startsWith('web '));

  expect(listed.code).toBe(0);
  expect(row).toInclude('container down');
});

test('#ls passes through as sent a host field that a newer impd adds to its imps', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  // a release after this CLI's adds `host` to each imp
  const newer = startStubImpdRelease(ctx.stack, box.sendRequest, {
    withFields: { 'imps/list': { host: 'peer' } },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: newer.url, token: box.rootToken } },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify(imps.map((imp) => Object.assign(imp, { host: 'peer' }))),
  );

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: '',
    code: 0,
  });
});

test('#ls names the saved host under --all over a host field that a newer impd adds', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  // a release after this CLI's adds `host` to each imp
  const newer = startStubImpdRelease(ctx.stack, box.sendRequest, {
    withFields: { 'imps/list': { host: 'peer' } },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: newer.url, token: box.rootToken } },
  });

  const listed = await runCLIInProcess({ args: ['ls', '--all', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them, each imp under its saved host's name
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify(imps.map((imp) => Object.assign(imp, { host: 'box' }))),
  );

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: { imps: sent, errors: [] },
    stderr: '',
    code: 0,
  });
});
