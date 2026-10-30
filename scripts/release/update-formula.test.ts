import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFreeEnv } from '@impz/e2e-harness/git-env';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-update-formula-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'tree', 'dist'), { recursive: true });

  return {
    directoryPath: directory,
    tree: join(directory, 'tree'),
    seed: join(directory, 'seed'),
    remote: join(directory, 'tap.git'),
    env: { ...createGitFreeEnv(process.env), HOME: directory },
    scriptPath: join(import.meta.dir, 'update-formula.ts'),
  };
}

test('it fails, running no command, for a tree without build-formula.sh', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.directoryPath, 'gh');

  createStubBin(ctx.directoryPath, 'git');
  writeFileSync(join(ctx.tree, 'dist', 'SHA256SUMS'), '');

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .env({
      ...ctx.env,
      PATH: gh.bin,
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '2.0.1',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'the checked-out tree has no build-formula.sh\n',
  });

  expect(readFileSync(gh.calls, 'utf8')).toBe('');
});

test('it leaves the formula of a tag from before the rename, class Imp, out of the tap', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.seed, 'Formula'), { recursive: true });

  writeFileSync(
    join(ctx.seed, 'Formula', 'impz.rb'),
    'class Impz < Formula\n  version "2.0.0"\nend\n',
  );

  await $`git -C ${ctx.seed} init -q -b main`.env(ctx.env).quiet();
  await $`git -C ${ctx.seed} add .`.env(ctx.env).quiet();

  await $`git -C ${ctx.seed} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  await $`git clone -q --bare ${ctx.seed} ${ctx.remote}`.env(ctx.env).quiet();

  mkdirSync(join(ctx.tree, 'scripts'));

  writeFileSync(
    join(ctx.tree, 'scripts', 'build-formula.sh'),
    '#!/bin/sh\nprintf \'class Imp < Formula\\n  version "%s"\\nend\\n\' "$1"\n',
    { mode: 0o755 },
  );

  writeFileSync(join(ctx.tree, 'dist', 'SHA256SUMS'), '');

  const gh = createStubBin(
    ctx.directoryPath,
    'gh',
    '[ "$1 $2" = "repo clone" ] && exec git clone -q "$STUB_TAP_REMOTE" "$4"\nexit 0',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...ctx.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '1.6.0',
      GITHUB_WORKSPACE: ctx.tree,
      STUB_TAP_REMOTE: ctx.remote,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout:
      'scripts/build-formula.sh printed class Imp; the tap offers only impz, so the formula stays\n',
  });

  const formula = await $`git --git-dir ${ctx.remote} show main:Formula/impz.rb`
    .env(ctx.env)
    .text();

  expect(formula).toBe('class Impz < Formula\n  version "2.0.0"\nend\n');

  const subject = await $`git --git-dir ${ctx.remote} log -1 --format=%s main`.env(ctx.env).text();

  expect(subject).toBe('seed\n');
});

test('it writes the formula of a tag after the rename to impz.rb with the generator in scripts/release', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.seed, 'Formula'), { recursive: true });

  writeFileSync(
    join(ctx.seed, 'Formula', 'impz.rb'),
    'class Impz < Formula\n  version "2.0.0"\nend\n',
  );

  await $`git -C ${ctx.seed} init -q -b main`.env(ctx.env).quiet();
  await $`git -C ${ctx.seed} add .`.env(ctx.env).quiet();

  await $`git -C ${ctx.seed} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  await $`git clone -q --bare ${ctx.seed} ${ctx.remote}`.env(ctx.env).quiet();

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });

  writeFileSync(
    join(ctx.tree, 'scripts', 'release', 'build-formula.sh'),
    readFileSync(join(import.meta.dir, 'build-formula.sh')),
    { mode: 0o755 },
  );

  writeFileSync(
    join(ctx.tree, 'dist', 'SHA256SUMS'),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
      .map((platform) => `${'1'.repeat(64)}  impz-${platform}\n`)
      .join(''),
  );

  const gh = createStubBin(
    ctx.directoryPath,
    'gh',
    '[ "$1 $2" = "repo clone" ] && exec git clone -q "$STUB_TAP_REMOTE" "$4"\nexit 0',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...ctx.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '2.0.1',
      GITHUB_WORKSPACE: ctx.tree,
      STUB_TAP_REMOTE: ctx.remote,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  const subject = await $`git --git-dir ${ctx.remote} log -1 --format=%s main`.env(ctx.env).text();

  expect(subject).toBe('impz 2.0.1\n');

  const formula = await $`git --git-dir ${ctx.remote} show main:Formula/impz.rb`
    .env(ctx.env)
    .text();

  expect(formula).toStartWith('class Impz < Formula\n');

  const listed = await $`git --git-dir ${ctx.remote} ls-tree --name-only main Formula/`
    .env(ctx.env)
    .text();

  expect(listed).toBe('Formula/impz.rb\n');
});

test('it pushes nothing when the tap holds the formula already', async () => {
  const ctx = setupTest();
  const formula = 'class Impz < Formula\n  version "2.0.1"\nend\n';

  mkdirSync(join(ctx.seed, 'Formula'), { recursive: true });
  writeFileSync(join(ctx.seed, 'Formula', 'impz.rb'), formula);

  await $`git -C ${ctx.seed} init -q -b main`.env(ctx.env).quiet();
  await $`git -C ${ctx.seed} add .`.env(ctx.env).quiet();

  await $`git -C ${ctx.seed} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  await $`git clone -q --bare ${ctx.seed} ${ctx.remote}`.env(ctx.env).quiet();

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });

  writeFileSync(
    join(ctx.tree, 'scripts', 'release', 'build-formula.sh'),
    `#!/bin/sh\nprintf '%s' '${formula}'\n`,
    { mode: 0o755 },
  );

  writeFileSync(join(ctx.tree, 'dist', 'SHA256SUMS'), '');

  const gh = createStubBin(
    ctx.directoryPath,
    'gh',
    '[ "$1 $2" = "repo clone" ] && exec git clone -q "$STUB_TAP_REMOTE" "$4"\nexit 0',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...ctx.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '2.0.1',
      GITHUB_WORKSPACE: ctx.tree,
      STUB_TAP_REMOTE: ctx.remote,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'the formula is at 2.0.1 already\n',
  });

  const subject = await $`git --git-dir ${ctx.remote} log -1 --format=%s main`.env(ctx.env).text();

  expect(subject).toBe('seed\n');
});

test('it fails the job, moving no formula, when the generator prints no formula class', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });

  writeFileSync(
    join(ctx.tree, 'scripts', 'release', 'build-formula.sh'),
    '#!/bin/sh\necho oops\n',
    {
      mode: 0o755,
    },
  );

  writeFileSync(join(ctx.tree, 'dist', 'SHA256SUMS'), '');

  const gh = createStubBin(
    ctx.directoryPath,
    'gh',
    '[ "$1 $2" = "repo clone" ] && mkdir -p "$4"\nexit 0',
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...ctx.env,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '2.0.1',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'scripts/release/build-formula.sh printed no formula class\n',
  });

  expect(readdirSync(join(ctx.tree, 'tap', 'Formula'))).toStrictEqual([]);
});
