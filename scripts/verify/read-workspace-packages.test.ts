import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readWorkspacePackages } from './read-workspace-packages.ts';

test('it reads each package folder and the scripts package, with their run-time dependencies', async () => {
  const packages = await readWorkspacePackages(join(import.meta.dir, '..', '..'));

  expect(packages).toIncludeAllMembers([
    {
      folder: 'packages/testing',
      name: '@impz/testing',
      workspaceDependencies: ['@impz/client'],
    },
    expect.objectContaining({ folder: 'scripts', name: '@impz/scripts' }),
  ]);
});
