import { expect, test } from 'bun:test';
import { buildStubTailscaleServe } from '../../../testing/network/build-stub-tailscale-serve';
import { createServiceServe, listServeEntries } from './service-serve';

test('it lists HTTPS on 443 and HTTP on 80 as what a service to a target serves', () => {
  expect(listServeEntries('http://127.0.0.1:20000')).toStrictEqual([
    '443 http://127.0.0.1:20000',
    '80 http://127.0.0.1:20000',
  ]);
});

test('it serves a service over HTTP on 80, then HTTPS on 443', async () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  await serve.writeServe('svc:box', 'http://127.0.0.1:20000');

  expect(tailscale.calls).toStrictEqual([
    ['tailscale', 'serve', '--service=svc:box', '--http=80', 'http://127.0.0.1:20000'],
    ['tailscale', 'serve', '--service=svc:box', '--https=443', 'http://127.0.0.1:20000'],
  ]);
});

test('it clears a service’s serve config', async () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  await serve.clearServe('svc:box');

  expect(tailscale.calls).toStrictEqual([['tailscale', 'serve', 'clear', 'svc:box']]);
});

test('it reads back what it served from tailscale serve status', async () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  await serve.writeServe('svc:box', 'http://127.0.0.1:20000');

  const served = await serve.readServed();

  expect(served).toStrictEqual(
    new Map([['svc:box', ['80 http://127.0.0.1:20000', '443 http://127.0.0.1:20000']]]),
  );
});

test('it rejects a read when tailscale serve status fails', () => {
  const tailscale = buildStubTailscaleServe();
  const serve = createServiceServe(tailscale.runChecked);

  tailscale.failNext('tailscaled is not running');

  expect(serve.readServed()).rejects.toThrow('tailscaled is not running');
});
