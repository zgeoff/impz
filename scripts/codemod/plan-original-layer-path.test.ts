import { expect, test } from 'bun:test';
import { planOriginalLayerPath } from './plan-original-layer-path';

test.each([
  ['a file of a moved folder', 'platform/db/imps.ts', 'db/imps.ts'],
  ['a file of the imps folder', 'imps/imps/imp-service.ts', 'imps/imp-service.ts'],
  ['a file that left its folder', 'surface/ssh/ssh-gateway.ts', 'ssh/ssh-gateway.ts'],
  ['a sibling that stayed in its folder', 'imps/ssh/channel-io.ts', 'ssh/channel-io.ts'],
  ['a file that moved into a folder', 'platform/process/merge-signals.ts', 'merge-signals.ts'],
  ['a root file', 'main.ts', 'main.ts'],
])('it finds the old path of %s: %s was %s', (_label, path, expected) => {
  expect(planOriginalLayerPath(path)).toBe(expected);
});
