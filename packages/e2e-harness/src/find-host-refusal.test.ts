import { expect, test } from 'bun:test';
import { findHostRefusal } from './find-host-refusal.ts';

test('it refuses a host without the zfs module', () => {
  expect(findHostRefusal({ module: 'missing' })).toBe(
    'load the zfs module first (sudo modprobe zfs)',
  );
});

test('it finds no refusal on a host where nothing is there yet', () => {
  expect(
    findHostRefusal({
      module: 'loaded',
      version: '2.3.4-1\n',
      pool: 'impbench4242',
      poolExists: false,
      existingPaths: [],
      existingContainers: [],
      existingNetworks: [],
    }),
  ).toBeNull();
});

test('it refuses a bench pool name that is taken before anything else that is there', () => {
  expect(
    findHostRefusal({
      module: 'loaded',
      version: '2.3.4-1\n',
      pool: 'impbench4242',
      poolExists: true,
      existingPaths: ['/var/tmp/imp-zfs.x/bench.img'],
      existingContainers: ['imp-zfs'],
      existingNetworks: ['imp-zfs-mv'],
    }),
  ).toBe('a pool named impbench4242 already exists; refusing to touch it');
});

test('it refuses the first path that is already there before a container', () => {
  expect(
    findHostRefusal({
      module: 'loaded',
      version: '2.3.4-1\n',
      pool: 'impbench4242',
      poolExists: false,
      existingPaths: ['/var/tmp/imp-zfs.x/data', '/var/tmp/imp-zfs.x/data-mv-b'],
      existingContainers: ['imp-zfs'],
      existingNetworks: [],
    }),
  ).toBe('/var/tmp/imp-zfs.x/data already exists; refusing to touch it');
});

test('it refuses the first container that is already there before a network', () => {
  expect(
    findHostRefusal({
      module: 'loaded',
      version: '2.3.4-1\n',
      pool: 'impbench4242',
      poolExists: false,
      existingPaths: [],
      existingContainers: ['imp-zfs-mv-b'],
      existingNetworks: ['imp-zfs-mv'],
    }),
  ).toBe('a container named imp-zfs-mv-b already exists; refusing to touch it');
});

test('it refuses a network that is already there', () => {
  expect(
    findHostRefusal({
      module: 'loaded',
      version: '2.3.4-1\n',
      pool: 'impbench4242',
      poolExists: false,
      existingPaths: [],
      existingContainers: [],
      existingNetworks: ['imp-zfs-mv'],
    }),
  ).toBe('a network named imp-zfs-mv already exists; refusing to touch it');
});
