import { expect, test } from 'bun:test';
import { buildKvmInstance } from './build-kvm-instance.ts';

test('it names the dev instance after the run folder, with its data inside the folder', () => {
  expect(buildKvmInstance('/w/imp/.wringer/runs/mwgh9fp8-4ten')).toStrictEqual({
    name: 'impz-verify-mwgh9fp8-4ten',
    dataDir: '/w/imp/.wringer/runs/mwgh9fp8-4ten/data',
  });
});
