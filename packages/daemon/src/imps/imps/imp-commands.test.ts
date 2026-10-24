import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '../../../testing/start-test-impd';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack);
}

test('it logs the create of an imp named like an area under the imps area, with the imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'gc' });

  expect(ctx.logs).toContainEqual(expect.toStartWith('INFO impd.imps imp=gc created in '));
  expect(ctx.logs).not.toContainEqual(expect.toInclude(' impd.gc '));
});
