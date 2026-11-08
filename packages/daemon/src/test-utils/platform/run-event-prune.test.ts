import { expect, test } from 'bun:test';
import { createTestDatabase } from './create-test-database';
import { runEventPrune } from './run-event-prune';

test('it removes the events older than the log keeps at the time it is given', async () => {
  const ctx = await createTestDatabase();

  await ctx.db.log.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'old-imp',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    Date.UTC(2026, 8, 1),
  );

  await runEventPrune(ctx.db, Date.UTC(2026, 9, 2));

  const read = await ctx.db.log.readAfter(0, 10);

  expect(read).toStrictEqual({ kind: 'reset', prunedThrough: 1 });
});
