import { expect, test } from 'bun:test';
import { captureImpdLogs } from '../../test-utils/platform/capture-impd-logs';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { createUnmigratedDatabase } from '../../test-utils/platform/create-unmigrated-database';

test('it writes an event no row describes, and the readers see it', async () => {
  const ctx = await createTestDatabase();

  await ctx.db.log.write(
    {
      ev: 'AgentExec',
      name: 'quiet-otter',
      actor: 'token',
      actorName: 'ci',
      tty: false,
      command: 'ls',
    },
    1_800_000_000_000,
  );

  const read = await ctx.db.log.readAfter(0, 10);

  expect(read).toStrictEqual({
    kind: 'events',
    events: [
      {
        ev: 'AgentExec',
        name: 'quiet-otter',
        actor: 'token',
        actorName: 'ci',
        tty: false,
        command: 'ls',
        seq: 1,
        at: new Date(1_800_000_000_000),
      },
    ],
    throughSeq: 1,
    hasMore: false,
  });
});

test('it logs a write that fails, and resolves', async () => {
  const db = createUnmigratedDatabase();
  const lines = captureImpdLogs();

  await db.log.write(
    {
      ev: 'AgentExec',
      name: 'quiet-otter',
      actor: 'token',
      actorName: 'ci',
      tty: false,
      command: 'ls',
    },
    1_800_000_000_000,
  );

  expect(lines).toSatisfyAny((line: string) => line.includes('failed to write a AgentExec event'));
});

test('it returns 0 for the head of a log with no events', async () => {
  const ctx = await createTestDatabase();
  const head = await ctx.db.log.readHead();

  expect(head).toBe(0);
});
