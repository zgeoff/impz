import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readProxyPrivileges } from './read-proxy-privileges.ts';

test("it reads the proxy's privileges from the args file, one word each", () => {
  expect(readProxyPrivileges(join(import.meta.dir, '..', '..'))).toStrictEqual([
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
