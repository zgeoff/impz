import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProxyPrivileges } from './read-proxy-privileges.ts';

test("it reads the proxy's privileges from the args file, one word each", () => {
  expect(
    readProxyPrivileges((path) => readFileSync(path, 'utf8'), join(import.meta.dir, '..', '..')),
  ).toStrictEqual([
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--network',
    'none',
    '--user',
    '65534:65534',
  ]);
});

test('it reads the args file through the reader it is given', () => {
  const args = readFileSync(
    join(import.meta.dir, '..', '..', 'deploy', 'imp-host.args.json'),
    'utf8',
  );

  const readText = mock(() => args);

  readProxyPrivileges(readText, '/w/imp');

  expect(readText).toHaveBeenCalledExactlyOnceWith('/w/imp/deploy/imp-host.args.json');
});

test('it refuses when the args file cannot be read', () => {
  expect(() => readProxyPrivileges(() => null, '/w/imp')).toThrowWithMessage(
    Error,
    'cannot read /w/imp/deploy/imp-host.args.json',
  );
});
