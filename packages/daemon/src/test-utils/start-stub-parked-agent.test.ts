import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { BootStepSchema, PingSchema } from '../agent-client/agent-protocol';
import { sendClaim, sendPing } from '../agent-client/agent-requests';
import { startStubParkedAgent } from './start-stub-parked-agent';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'stub-parked-agent-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it answers a ping as a parked template guest a minute old', async () => {
  const ctx = await setupTest();

  await startStubParkedAgent(join(ctx.directoryPath, 'v.sock'));

  const ping = await sendPing(join(ctx.directoryPath, 'v.sock'));

  expect(ping).toStrictEqual(
    create(PingSchema, { ok: true, version: '0.1.0', uptimeMs: 60_000, stage: 'template' }),
  );
});

test('it answers a ping as a booted imp once claimed', async () => {
  const ctx = await setupTest();

  await startStubParkedAgent(join(ctx.directoryPath, 'v.sock'));

  await sendClaim(join(ctx.directoryPath, 'v.sock'), {
    id: 'i1',
    hostname: 'dev',
    ip: '10.66.0.2/30',
    gw: '10.66.0.1',
    ip6: null,
    gw6: null,
    dns: ['1.1.1.1'],
    mac: '06:00:0a:42:00:02',
    diskBytes: 0,
    unixMs: 0,
    seed: new Uint8Array(64),
    isIdentityReset: false,
  });

  const ping = await sendPing(join(ctx.directoryPath, 'v.sock'));

  expect(ping.stage).toBeUndefined();
});

test('it reports the steps of its boot after the claim once claimed', async () => {
  const ctx = await setupTest();

  await startStubParkedAgent(join(ctx.directoryPath, 'v.sock'));

  await sendClaim(join(ctx.directoryPath, 'v.sock'), {
    id: 'i1',
    hostname: 'dev',
    ip: '10.66.0.2/30',
    gw: '10.66.0.1',
    ip6: null,
    gw6: null,
    dns: ['1.1.1.1'],
    mac: '06:00:0a:42:00:02',
    diskBytes: 0,
    unixMs: 0,
    seed: new Uint8Array(64),
    isIdentityReset: false,
  });

  const ping = await sendPing(join(ctx.directoryPath, 'v.sock'));

  // oxlint-disable zgeoff/no-abbreviated-names -- `ms` is BootStep's field in proto/
  expect(ping.bootSteps).toStrictEqual([
    create(BootStepSchema, { name: 'claim', ms: 3 }),
    create(BootStepSchema, { name: 'mount', ms: 40 }),
    create(BootStepSchema, { name: 'ready', ms: 2 }),
  ]);
  // oxlint-enable zgeoff/no-abbreviated-names
});
