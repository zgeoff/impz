import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubTailscale } from './create-stub-tailscale';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-tailscale-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the node it was given as its status', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });
});

test('it fails status before any node is written, as with no tailscaled', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(result.exitCode).toBe(1);
});

test('it reports Starting while held, whatever the node says', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  tailscale.holdStart();

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({ BackendState: 'Starting' });
});

test('it reports the node again once the start is released', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writeNode({
    BackendState: 'NeedsLogin',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  tailscale.holdStart();
  tailscale.releaseStart();

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'status',
    '--json',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    BackendState: 'NeedsLogin',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });
});

test('it saves a Running node with the hostname and tags that up names', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'up',
    '--reset',
    '--auth-key=file:/run/key',
    '--hostname=imp-b',
    '--advertise-tags=tag:a,tag:b',
    '--accept-dns=false',
  ]);

  expect(tailscale.readNode()).toStrictEqual({
    BackendState: 'Running',
    Self: {
      HostName: 'imp-b',
      Tags: ['tag:a', 'tag:b'],
      TailscaleIPs: ['100.64.0.9'],
      DNSName: 'imp.tail1234.ts.net.',
    },
  });
});

test("it prints Tailscale's own server as the control URL before any prefs or up", () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'debug',
    'prefs',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    ControlURL: 'https://controlplane.tailscale.com',
  });
});

test('it prints the prefs it was given', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writePrefs({ ControlURL: 'http://headscale.test:8080' });

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'debug',
    'prefs',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    ControlURL: 'http://headscale.test:8080',
  });
});

test('it saves the login server that up names as the control URL', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'up',
    '--hostname=imp',
    '--login-server=http://headscale.test:8080',
  ]);

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'debug',
    'prefs',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    ControlURL: 'http://headscale.test:8080',
  });
});

test('it refuses to move a Running node to another control server without --force-reauth', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'up',
    '--hostname=imp',
    '--login-server=http://headscale.test:8080',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: "can't change --login-server without --force-reauth\n",
  });
});

test('it moves a Running node to another control server with --force-reauth', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: [], TailscaleIPs: ['100.64.0.7'], DNSName: 'imp.ts.net.' },
  });

  Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'up',
    '--force-reauth',
    '--hostname=imp',
    '--login-server=http://headscale.test:8080',
  ]);

  const result = Bun.spawnSync([
    join(tailscale.bin, 'tailscale'),
    '--socket=/run/ts.sock',
    'debug',
    'prefs',
  ]);

  expect(JSON.parse(result.stdout.toString())).toStrictEqual({
    ControlURL: 'http://headscale.test:8080',
  });
});

test('it stops the node on down and keeps the rest of it', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  tailscale.writeNode({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.ts.net.',
    },
  });

  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'down']);

  expect(tailscale.readNode()).toStrictEqual({
    BackendState: 'Stopped',
    Self: {
      HostName: 'imp',
      Tags: ['tag:imp'],
      TailscaleIPs: ['100.64.0.7'],
      DNSName: 'imp.ts.net.',
    },
  });
});

test('it reads back the arguments after the socket of each call with one verb, in order', () => {
  const ctx = setupTest();
  const tailscale = createStubTailscale(ctx.directoryPath);

  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'up', '--hostname=a']);
  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'down']);
  Bun.spawnSync([join(tailscale.bin, 'tailscale'), '--socket=/run/ts.sock', 'up', '--hostname=b']);

  expect(tailscale.readCalls('up')).toStrictEqual(['up --hostname=a', 'up --hostname=b']);
});
