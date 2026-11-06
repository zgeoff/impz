import { expect, test } from 'bun:test';
import { buildPebbleNames } from './build-pebble-names';

test('it names the network, both containers and the minica file after the prefix', () => {
  expect(buildPebbleNames('imp-wt', '/var/cache/e2e')).toStrictEqual({
    prefix: 'imp-wt',
    network: 'imp-wt-acme',
    pebble: 'imp-wt-pebble',
    challtestsrv: 'imp-wt-challtestsrv',
    minicaFile: '/var/cache/e2e/imp-wt-pebble-minica.pem',
  });
});
