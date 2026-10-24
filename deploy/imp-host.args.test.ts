import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseHostArgs } from '../scripts/render/render-imp-host';

test('it runs nothing --privileged', () => {
  const args = parseHostArgs(readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'));
  const words = [...args.privileges, ...args.lines, ...args.proxy.privileges, ...args.proxy.lines];

  expect(words.flat()).not.toContain('--privileged');
});

test('it gives imp-host only the proxy socket, read-only', () => {
  const args = parseHostArgs(readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'));
  const hostWords = [...args.privileges, ...args.lines].flat();

  expect(hostWords.filter((word) => word.includes('docker.sock'))).toStrictEqual([
    'DOCKER_HOST=unix:///run/imp-docker/docker.sock',
  ]);

  expect(hostWords).toContain('/run/imp-docker:/run/imp-docker:ro');
});

test("it gives the proxy the host's docker.sock with no capabilities or network", () => {
  const args = parseHostArgs(readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'));
  const proxyWords = [...args.proxy.privileges, ...args.proxy.lines].flat();

  expect(proxyWords).toContain('/var/run/docker.sock:/var/run/docker.sock');
  expect(proxyWords).not.toContain('--cap-add');
  expect(proxyWords).not.toContain('--env-file');

  expect(proxyWords.join(' ')).toIncludeMultiple([
    '--cap-drop ALL',
    '--network none',
    '--security-opt no-new-privileges',
    '--user 65534:65534',
  ]);
});

test('it probes only devices that compose.zfs.yaml passes', () => {
  const override = readFileSync(new URL('compose.zfs.yaml', import.meta.url), 'utf8');

  const probed = parseHostArgs(
    readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'),
  ).probed;

  expect(
    probed.filter((entry) => entry.args[0] === '--device').map((entry) => `- ${entry.path}`),
  ).toSatisfyAll((line: string) => override.includes(line));
});
