import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFreeEnv, runGitChecked } from '../../e2e/lib/git-env';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-breaking-change-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  await runGitChecked(['git', 'init', '--quiet', '--initial-branch=main', directory]);

  // git refuses a commit without an author, and the host's signing setup must not apply.
  await runGitChecked(['git', '-C', directory, 'config', 'user.name', 'test']);
  await runGitChecked(['git', '-C', directory, 'config', 'user.email', 'test@example.com']);
  await runGitChecked(['git', '-C', directory, 'config', 'commit.gpgsign', 'false']);
  await mkdir(join(directory, 'packages/api'), { recursive: true });
  await mkdir(join(directory, 'packages/cli'), { recursive: true });

  return {
    directoryPath: directory,
    schemaPath: join(directory, 'packages/api/protocol-schema.json'),
    outputsPath: join(directory, 'packages/cli/json-output-schema.json'),
  };
}

test('it fails a pull request that breaks the protocol without a mark', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
        'imps.list': { input: { type: 'object' }, output: { type: 'array' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'feat: add imps',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'drop-get']);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.list': { input: { type: 'object' }, output: { type: 'array' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat: drop imps.get',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'feat: drop imps.get',
        PR_BODY: '',
      },
    },
  );

  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  expect(stderr).toBe(
    'check-breaking-change: this pull request breaks the protocol a client of the same major speaks:\n' +
      '  - procedure imps.get: removed\n\n' +
      'Keep the change compatible, or mark it so release-please bumps the major: a `!` after the\n' +
      "type, as in `feat(#740)!: …`, in the PR title (several commits) or in the commit's subject\n" +
      '(one commit), or a `BREAKING CHANGE: <what breaks>` footer in a commit message.\n',
  );

  expect(exitCode).toBe(1);
});

test('it passes a breaking change whose lone commit has a ! subject', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'feat: add imps',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'drop-get']);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat!: drop imps.get',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'feat: drop imps.get',
        PR_BODY: '',
      },
    },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect(stdout).toBe(
    'check-breaking-change: breaking changes, marked so the release bumps the major:\n' +
      '  - procedure imps.get: removed\n',
  );

  expect(exitCode).toBe(0);
});

test('it passes a breaking change with a BREAKING CHANGE footer in one of several commits', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'feat: add imps',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'drop-get']);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat: drop imps.get\n\nBREAKING CHANGE: imps.get is gone; use imps.list',
  ]);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'docs: a',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'feat: drop imps.get',
        PR_BODY: '',
      },
    },
  );

  const exitCode = await subprocess.exited;

  expect(exitCode).toBe(0);
});

test('it fails a breaking change whose ! sits on a later commit of several', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'feat: add imps',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'drop-get']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'docs: a',
  ]);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat!: drop imps.get',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'feat: drop imps.get',
        PR_BODY: '',
      },
    },
  );

  const exitCode = await subprocess.exited;

  expect(exitCode).toBe(1);
});

test('it passes a compatible change without a mark', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);
  await runGitChecked(['git', '-C', ctx.directoryPath, 'commit', '--quiet', '-m', 'feat: start']);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'add-get']);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat: add imps.get',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'feat: add imps.get',
        PR_BODY: '',
      },
    },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect(stdout).toBe('check-breaking-change: no breaking change to the protocol\n');
  expect(exitCode).toBe(0);
});

test('it compares from the merge base, so what main adds later is no removal', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);
  await runGitChecked(['git', '-C', ctx.directoryPath, 'commit', '--quiet', '-m', 'feat: start']);
  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'docs']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'docs: a',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', 'main']);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({
      procedures: {
        'imps.get': { input: { type: 'object' }, output: { type: 'object' }, stream: false },
      },
      messages: {},
      errors: {},
      constants: {},
    }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat: add imps.get',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'docs: a',
        PR_BODY: '',
      },
    },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect(stdout).toBe('check-breaking-change: no breaking change to the protocol\n');
  expect(exitCode).toBe(0);
});

test('it passes when the base has no protocol schema yet', async () => {
  const ctx = await setupTest();

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'chore: a',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'add-schema']);

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'ci: add the schema',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'ci: add the schema',
        PR_BODY: '',
      },
    },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  expect(stdout).toBe(
    'check-breaking-change: no packages/api/protocol-schema.json at the base; nothing to compare\n',
  );

  expect(exitCode).toBe(0);
});

test('it fails a pull request that removes the protocol schema', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'ci: add the schema',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'remove-schema']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'rm',
    '--quiet',
    'packages/api/protocol-schema.json',
  ]);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'ci: remove the schema',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'ci: remove the schema',
        PR_BODY: '',
      },
    },
  );

  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  expect(stderr).toBe(
    'check-breaking-change: the pull request removes packages/api/protocol-schema.json\n',
  );

  expect(exitCode).toBe(1);
});

test('it fails a pull request that renames a field of a --json output without a mark', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await writeFile(
    ctx.outputsPath,
    JSON.stringify({
      outputs: {
        info: {
          procedure: 'system.info',
          schema: {
            type: 'object',
            properties: { ramBudgetMib: { type: 'integer' } },
            required: ['ramBudgetMib'],
            additionalProperties: false,
          },
        },
      },
    }),
  );

  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'feat: add info',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked(['git', '-C', ctx.directoryPath, 'switch', '--quiet', '-c', 'rename-budget']);

  await writeFile(
    ctx.outputsPath,
    JSON.stringify({
      outputs: {
        info: {
          procedure: 'system.info',
          schema: {
            type: 'object',
            properties: { ramLimitMib: { type: 'integer' } },
            required: ['ramLimitMib'],
            additionalProperties: false,
          },
        },
      },
    }),
  );

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-am',
    'feat: rename the budget',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'feat: rename the budget',
        PR_BODY: '',
      },
    },
  );

  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  expect(stderr).toBe(
    'check-breaking-change: this pull request breaks the protocol a client of the same major speaks:\n' +
      '  - impz info --json .ramBudgetMib: may now be missing\n\n' +
      'Keep the change compatible, or mark it so release-please bumps the major: a `!` after the\n' +
      "type, as in `feat(#740)!: …`, in the PR title (several commits) or in the commit's subject\n" +
      '(one commit), or a `BREAKING CHANGE: <what breaks>` footer in a commit message.\n',
  );

  expect(exitCode).toBe(1);
});

test('it fails a pull request that removes the --json output schema', async () => {
  const ctx = await setupTest();

  await writeFile(
    ctx.schemaPath,
    JSON.stringify({ procedures: {}, messages: {}, errors: {}, constants: {} }),
  );

  await writeFile(ctx.outputsPath, JSON.stringify({ outputs: {} }));
  await runGitChecked(['git', '-C', ctx.directoryPath, 'add', '.']);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'ci: add the schemas',
  ]);

  const baseOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const baseSHA = baseOut.trim();

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'switch',
    '--quiet',
    '-c',
    'remove-outputs',
  ]);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'rm',
    '--quiet',
    'packages/cli/json-output-schema.json',
  ]);

  await runGitChecked([
    'git',
    '-C',
    ctx.directoryPath,
    'commit',
    '--quiet',
    '-m',
    'ci: remove the outputs',
  ]);

  const headOut = await runGitChecked(['git', '-C', ctx.directoryPath, 'rev-parse', 'HEAD']);

  const headSHA = headOut.trim();

  const subprocess = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'check-breaking-change.ts')],
    {
      cwd: ctx.directoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...createGitFreeEnv(process.env),
        BASE_SHA: baseSHA,
        HEAD_SHA: headSHA,
        PR_NUMBER: '7',
        PR_TITLE: 'ci: remove the outputs',
        PR_BODY: '',
      },
    },
  );

  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  expect(stderr).toBe(
    'check-breaking-change: this pull request breaks the protocol a client of the same major speaks:\n' +
      '  - packages/cli/json-output-schema.json: removed\n\n' +
      'Keep the change compatible, or mark it so release-please bumps the major: a `!` after the\n' +
      "type, as in `feat(#740)!: …`, in the PR title (several commits) or in the commit's subject\n" +
      '(one commit), or a `BREAKING CHANGE: <what breaks>` footer in a commit message.\n',
  );

  expect(exitCode).toBe(1);
});
