import { expect, test } from 'bun:test';
import { buildStubTailscaleServe } from '../../../testing/network/build-stub-tailscale-serve';
import { parseServeStatus, readServePorts } from './tailscale-serve';

test('#parseServeStatus reads the ports tailscale serve holds, and each served service as its ports and proxy targets', () => {
  const json = JSON.stringify({
    TCP: { '443': { HTTPS: true }, '20000': { HTTPS: true } },
    Web: { 'imp.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } } },
    Services: {
      'svc:box': {
        TCP: { '80': { HTTP: true }, '443': { HTTPS: true } },
        Web: {
          'box.tail1234.ts.net:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } },
          'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } },
        },
      },
      'svc:raw': { TCP: { '5432': { TCPForward: '127.0.0.1:5432' } } },
    },
  });

  expect(parseServeStatus(json)).toStrictEqual({
    ports: [443, 20_000],
    services: new Map([
      ['svc:box', ['80 http://127.0.0.1:20000', '443 http://127.0.0.1:20000']],
      ['svc:raw', []],
    ]),
  });
});

test.each([
  ['an empty config', '{}'],
  ['no output', ''],
  ['output that is not JSON', 'No serve config'],
  ['JSON of the wrong shape', '{"Services": []}'],
])('#parseServeStatus reads %s as no port held and nothing served', (_label, json) => {
  expect(parseServeStatus(json)).toStrictEqual({ ports: [], services: new Map() });
});

test('#parseServeStatus skips a TCP key that is not a port', () => {
  const json = JSON.stringify({ TCP: { '443': { HTTPS: true }, web: { HTTPS: true } } });

  expect(parseServeStatus(json).ports).toStrictEqual([443]);
});

test('#readServePorts reads the held ports from tailscale serve status', async () => {
  const serve = buildStubTailscaleServe();

  serve.holdPort(443);

  const ports = await readServePorts(serve.run);

  expect(ports).toStrictEqual([443]);
});

test('#readServePorts holds no port when tailscale serve status fails', async () => {
  const serve = buildStubTailscaleServe();

  serve.holdPort(443);
  serve.failNext('tailscaled is not running');

  const ports = await readServePorts(serve.run);

  expect(ports).toStrictEqual([]);
});

test('#readServePorts holds no port when tailscale cannot run', async () => {
  const ports = await readServePorts(() =>
    Promise.reject(new Error('Executable not found in $PATH: "tailscale"')),
  );

  expect(ports).toStrictEqual([]);
});
