import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecordingFirecrackerClient } from './make-recording-firecracker-client';
import { startStubFirecracker } from './start-stub-firecracker';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'recording-fc-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { apiSocket: join(directory, 'api.sock'), logPath: join(directory, 'calls.log') };
}

test('it answers each call from the Firecracker at the socket it is given', async () => {
  const ctx = setupTest();

  await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  const client = makeRecordingFirecrackerClient([])(ctx.apiSocket);

  const state = await client.readInstanceState();

  expect(state).toBe('Running');
});

test('it records the socket and the method of each call, in order', async () => {
  const ctx = setupTest();
  const calls: string[] = [];

  await startStubFirecracker({ apiSocket: ctx.apiSocket, logPath: ctx.logPath });

  const client = makeRecordingFirecrackerClient(calls)(ctx.apiSocket);

  await client.pause();
  await client.resume();

  expect(calls).toStrictEqual([`${ctx.apiSocket} pause`, `${ctx.apiSocket} resume`]);
});

test('it records a call that fails', () => {
  const ctx = setupTest();
  const calls: string[] = [];
  const client = makeRecordingFirecrackerClient(calls)(ctx.apiSocket);

  expect(client.readVersion()).rejects.toThrow();
  expect(calls).toStrictEqual([`${ctx.apiSocket} readVersion`]);
});
