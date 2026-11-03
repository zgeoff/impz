import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '../start-test-impd';
import { seedLoopbackImp } from './seed-loopback-imp';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack);
}

test('it creates the imp with the loopback address and the given input', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await seedLoopbackImp(
    { db: ctx.db, imps: ctx.impd.imps },
    { name: 'web', httpPort: 3000 },
  );

  const row = await ctx.db
    .selectFrom('imps')
    .selectAll()
    .where('id', '=', imp.id)
    .executeTakeFirstOrThrow();

  expect(row).toMatchObject({ name: 'web', ip: '127.0.0.1', http_port: 3000 });
});
