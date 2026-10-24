import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from './start-test-impd';

async function setupTest() {
  const impd = await startTestImpd();

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');
  await impd.client.imps.create({ name: 'box', image: 'ubuntu' });

  return { impd };
}

test('it serves impd at its url to a client that holds its token', async () => {
  const ctx = await setupTest();
  const response = await fetch(`${ctx.impd.url}/health`);
  const imps = await ctx.impd.client.imps.list();

  expect(response.status).toBe(200);
  expect(imps.map((imp) => imp.name)).toStrictEqual(['box']);
});

test('it fails to fire a ticker that impd does not wait on', async () => {
  const ctx = await setupTest();

  expect(ctx.impd.fireTicker('no-such-ticker')).rejects.toThrow(
    'nothing waits on a timer named no-such-ticker',
  );
});

test('it stops impd, which then answers no request', async () => {
  const impd = await startTestImpd();

  const url = impd.url;

  await impd.stop();

  expect(fetch(`${url}/health`)).rejects.toThrow();
});
