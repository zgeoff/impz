import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-pack-npm-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'outputs'), '');
  mkdirSync(join(directory, 'tree'));

  return {
    tree: join(directory, 'tree'),
    outputs: join(directory, 'outputs'),
    checks: join(directory, 'checks'),
    scriptPath: join(import.meta.dir, 'pack-npm-packages.ts'),
  };
}

test('it packs and checks both packages, and hands both tarballs on', async () => {
  const ctx = setupTest();
  const folder = join(ctx.tree, 'scripts', 'release');

  mkdirSync(folder, { recursive: true });

  writeFileSync(
    join(folder, 'pack-client.sh'),
    '#!/bin/sh\nmkdir -p build/npm\necho client > build/npm/impz-client-2.0.1.tgz\necho "$PWD/build/npm/impz-client-2.0.1.tgz"\n',
    { mode: 0o755 },
  );

  writeFileSync(
    join(folder, 'pack-testing.sh'),
    '#!/bin/sh\nmkdir -p build/npm\necho testing > build/npm/impz-testing-2.0.1.tgz\necho "$PWD/build/npm/impz-testing-2.0.1.tgz"\n',
    { mode: 0o755 },
  );

  writeFileSync(
    join(folder, 'check-client-package.sh'),
    `#!/bin/sh\necho "client $*" >> '${ctx.checks}'\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(folder, 'check-testing-package.sh'),
    `#!/bin/sh\necho "testing $*" >> '${ctx.checks}'\n`,
    { mode: 0o755 },
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      CLIENT: 'true',
      TESTING: 'true',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.outputs, 'utf8')).toBe(
    'client_tarball=impz-client-2.0.1.tgz\ntesting_tarball=impz-testing-2.0.1.tgz\n',
  );

  expect(readdirSync(join(ctx.tree, 'npm-tarball')).toSorted()).toStrictEqual([
    'impz-client-2.0.1.tgz',
    'impz-testing-2.0.1.tgz',
  ]);

  expect(readFileSync(ctx.checks, 'utf8')).toBe(
    [
      `client ${ctx.tree}/build/npm/impz-client-2.0.1.tgz`,
      `testing ${ctx.tree}/build/npm/impz-testing-2.0.1.tgz ${ctx.tree}/build/npm/impz-client-2.0.1.tgz`,
      '',
    ].join('\n'),
  );
});

test('it packs and checks the client for the testing package alone, and hands on only the testing tarball', async () => {
  const ctx = setupTest();
  const folder = join(ctx.tree, 'scripts', 'release');

  mkdirSync(folder, { recursive: true });

  writeFileSync(
    join(folder, 'pack-client.sh'),
    '#!/bin/sh\nmkdir -p build/npm\necho client > build/npm/impz-client-2.0.1.tgz\necho "$PWD/build/npm/impz-client-2.0.1.tgz"\n',
    { mode: 0o755 },
  );

  writeFileSync(
    join(folder, 'pack-testing.sh'),
    '#!/bin/sh\nmkdir -p build/npm\necho testing > build/npm/impz-testing-2.0.1.tgz\necho "$PWD/build/npm/impz-testing-2.0.1.tgz"\n',
    { mode: 0o755 },
  );

  writeFileSync(
    join(folder, 'check-client-package.sh'),
    `#!/bin/sh\necho "client $*" >> '${ctx.checks}'\n`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(folder, 'check-testing-package.sh'),
    `#!/bin/sh\necho "testing $*" >> '${ctx.checks}'\n`,
    { mode: 0o755 },
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      CLIENT: 'false',
      TESTING: 'true',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('testing_tarball=impz-testing-2.0.1.tgz\n');
  expect(readdirSync(join(ctx.tree, 'npm-tarball'))).toStrictEqual(['impz-testing-2.0.1.tgz']);

  expect(readFileSync(ctx.checks, 'utf8')).toBe(
    [
      `client ${ctx.tree}/build/npm/impz-client-2.0.1.tgz`,
      `testing ${ctx.tree}/build/npm/impz-testing-2.0.1.tgz ${ctx.tree}/build/npm/impz-client-2.0.1.tgz`,
      '',
    ].join('\n'),
  );
});

test('it packs the client of a tag that keeps its scripts in scripts/', async () => {
  const ctx = setupTest();
  const folder = join(ctx.tree, 'scripts');

  mkdirSync(folder, { recursive: true });

  writeFileSync(
    join(folder, 'pack-client.sh'),
    '#!/bin/sh\nmkdir -p build/npm\necho client > build/npm/impz-client-1.6.0.tgz\necho "$PWD/build/npm/impz-client-1.6.0.tgz"\n',
    { mode: 0o755 },
  );

  writeFileSync(join(folder, 'check-client-package.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      CLIENT: 'true',
      TESTING: 'false',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('client_tarball=impz-client-1.6.0.tgz\n');
});

test('it hands nothing on when the client fails its check', async () => {
  const ctx = setupTest();
  const folder = join(ctx.tree, 'scripts', 'release');

  mkdirSync(folder, { recursive: true });

  writeFileSync(
    join(folder, 'pack-client.sh'),
    '#!/bin/sh\nmkdir -p build/npm\necho client > build/npm/impz-client-2.0.1.tgz\necho "$PWD/build/npm/impz-client-2.0.1.tgz"\n',
    { mode: 0o755 },
  );

  writeFileSync(join(folder, 'check-client-package.sh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      CLIENT: 'true',
      TESTING: 'false',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});
