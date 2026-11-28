import { expect, test } from 'bun:test';
import { collectReachedFolders } from './collect-reached-folders.ts';

test.each([
  {
    title: 'a seed with no dependencies',
    seeds: ['packages/kettle'],
    packages: [{ folder: 'packages/kettle', name: '@impz/kettle', workspaceDependencies: [] }],
    skipped: [],
    reached: ['packages/kettle'],
  },
  {
    title: 'the dependencies of a dependency',
    seeds: ['packages/teapot'],
    packages: [
      { folder: 'packages/teapot', name: '@impz/teapot', workspaceDependencies: ['@impz/kettle'] },
      { folder: 'packages/kettle', name: '@impz/kettle', workspaceDependencies: ['@impz/clock'] },
      { folder: 'packages/clock', name: '@impz/clock', workspaceDependencies: [] },
      { folder: 'packages/saucer', name: '@impz/saucer', workspaceDependencies: [] },
    ],
    skipped: [],
    reached: ['packages/clock', 'packages/kettle', 'packages/teapot'],
  },
  {
    title: 'each package of a cycle once',
    seeds: ['packages/cup'],
    packages: [
      { folder: 'packages/cup', name: '@impz/cup', workspaceDependencies: ['@impz/saucer'] },
      { folder: 'packages/saucer', name: '@impz/saucer', workspaceDependencies: ['@impz/cup'] },
    ],
    skipped: [],
    reached: ['packages/cup', 'packages/saucer'],
  },
  {
    title: 'no skipped dependency, nor what only it depends on',
    seeds: ['packages/teapot'],
    packages: [
      {
        folder: 'packages/teapot',
        name: '@impz/teapot',
        workspaceDependencies: ['@impz/kettle', '@impz/spout'],
      },
      { folder: 'packages/kettle', name: '@impz/kettle', workspaceDependencies: ['@impz/clock'] },
      { folder: 'packages/clock', name: '@impz/clock', workspaceDependencies: [] },
      { folder: 'packages/spout', name: '@impz/spout', workspaceDependencies: [] },
    ],
    skipped: ['packages/kettle'],
    reached: ['packages/spout', 'packages/teapot'],
  },
  {
    title: 'a skipped seed',
    seeds: ['packages/kettle'],
    packages: [{ folder: 'packages/kettle', name: '@impz/kettle', workspaceDependencies: [] }],
    skipped: ['packages/kettle'],
    reached: ['packages/kettle'],
  },
  {
    title: 'a seed folder with no package, as after its deletion',
    seeds: ['packages/gone'],
    packages: [],
    skipped: [],
    reached: ['packages/gone'],
  },
  {
    title: 'no folder for a dependency outside the workspace',
    seeds: ['packages/kettle'],
    packages: [
      {
        folder: 'packages/kettle',
        name: '@impz/kettle',
        workspaceDependencies: ['@impz/elsewhere'],
      },
    ],
    skipped: [],
    reached: ['packages/kettle'],
  },
])('it reaches $title', (row) => {
  expect(collectReachedFolders(row.seeds, row.packages, new Set(row.skipped))).toStrictEqual([
    ...row.reached,
  ]);
});
