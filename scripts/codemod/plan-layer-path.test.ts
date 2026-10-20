import { expect, test } from 'bun:test';
import { planLayerPath } from './plan-layer-path';

test.each([
  ['a folder', 'db/imps.ts', 'platform/db/imps.ts'],
  ['a folder without an extension', 'db/imps', 'platform/db/imps'],
  ['a test beside its module', 'net/addressing.test.ts', 'host-net/net/addressing.test.ts'],
  ['a file that leaves its folder', 'ssh/ssh-gateway.ts', 'surface/ssh/ssh-gateway.ts'],
  ['a sibling of a file that leaves', 'ssh/channel-io.ts', 'imps/ssh/channel-io.ts'],
  ['a file of the old imps folder', 'imps/imp-service.ts', 'imps/imps/imp-service.ts'],
  ['a placed file of the imps layer', 'imps/imps/imp-service.ts', 'imps/imps/imp-service.ts'],
  ['a placed file', 'platform/db/imps.ts', 'platform/db/imps.ts'],
  ['a file at the top of src', 'create-app.ts', 'surface/create-app.ts'],
  ['a root file', 'main.ts', 'main.ts'],
  ['a name that only starts like a stem', 'token-store.ts', 'token-store.ts'],
])('it moves %s from %s to %s', (_label, path, expected) => {
  expect(planLayerPath(path)).toBe(expected);
});
