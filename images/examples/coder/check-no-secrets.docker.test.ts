import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

async function setupTest() {
  const contextPath = await mkdtemp(join(tmpdir(), 'check-no-secrets-'));

  onTestFinished(() => rm(contextPath, { recursive: true, force: true }));

  const tag = `impz-check-no-secrets:${crypto.randomUUID()}`;

  // Bun waits out the hook's timeout on a returned shell promise, so await it
  onTestFinished(async () => {
    await $`docker image rm --force ${tag}`.nothrow().quiet();
  });

  return {
    contextPath,
    tag,
    scriptPath: join(import.meta.dir, 'check-no-secrets.sh'),
  };
}

test('it passes an image of local files that holds no secret', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.contextPath, 'root/root'), { recursive: true });
  await writeFile(join(ctx.contextPath, 'root/root/.bashrc'), 'export EDITOR=vi\n');
  await writeFile(join(ctx.contextPath, 'Dockerfile'), 'FROM scratch\nCOPY root/ /\n');

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`.nothrow().quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: `check-no-secrets: ok (${ctx.tag})\n`,
    stderr: '',
  });
});

test('it fails the same image with a GitHub token planted in a text file', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.contextPath, 'root/root'), { recursive: true });

  await writeFile(
    join(ctx.contextPath, 'root/root/.bashrc'),
    'export EDITOR=vi\nexport GH_TOKEN=ghp_exampleexampleexampleexampleexample1\n',
  );

  await writeFile(join(ctx.contextPath, 'Dockerfile'), 'FROM scratch\nCOPY root/ /\n');

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`.nothrow().quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'check-no-secrets: the image holds a token in /root/.bashrc\n',
  });
});

test('it fails an image whose later layer overwrites a file that held a token', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.contextPath, 'login/root'), { recursive: true });
  await mkdir(join(ctx.contextPath, 'clean/root'), { recursive: true });

  await writeFile(
    join(ctx.contextPath, 'login/root/.bashrc'),
    'export GH_TOKEN=ghp_exampleexampleexampleexampleexample1\n',
  );

  await writeFile(join(ctx.contextPath, 'clean/root/.bashrc'), 'export EDITOR=vi\n');

  await writeFile(
    join(ctx.contextPath, 'Dockerfile'),
    'FROM scratch\nCOPY login/ /\nCOPY clean/ /\n',
  );

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`.nothrow().quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'check-no-secrets: the image holds a token in /root/.bashrc\n',
  });
});

test('it fails without a verdict when it cannot list the image layers', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.contextPath, 'root/root'), { recursive: true });
  await mkdir(join(ctx.contextPath, 'bin'));
  await writeFile(join(ctx.contextPath, 'bin/jq'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  await writeFile(join(ctx.contextPath, 'root/root/.bashrc'), 'export EDITOR=vi\n');
  await writeFile(join(ctx.contextPath, 'Dockerfile'), 'FROM scratch\nCOPY root/ /\n');

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`
    .env({ ...process.env, PATH: `${join(ctx.contextPath, 'bin')}:${process.env['PATH'] ?? ''}` })
    .nothrow()
    .quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 127,
    stdout: '',
    stderr: '',
  });
});

test('it fails an image that holds a Claude Code credentials file', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.contextPath, 'root/root/.claude'), { recursive: true });
  await writeFile(join(ctx.contextPath, 'root/root/.claude/.credentials.json'), '{}\n');
  await writeFile(join(ctx.contextPath, 'Dockerfile'), 'FROM scratch\nCOPY root/ /\n');

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`.nothrow().quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'check-no-secrets: the image holds login state: /root/.claude/.credentials.json\n',
  });
});

test('it fails an image whose env sets a credential variable', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.contextPath, 'motd'), 'welcome\n');

  await writeFile(
    join(ctx.contextPath, 'Dockerfile'),
    'FROM scratch\nENV CLAUDE_CODE_OAUTH_TOKEN=invented-value\nCOPY motd /etc/motd\n',
  );

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`.nothrow().quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'check-no-secrets: the image env sets CLAUDE_CODE_OAUTH_TOKEN=\n',
  });
});

test('it fails an image whose build history holds a token', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.contextPath, 'motd'), 'welcome\n');

  await writeFile(
    join(ctx.contextPath, 'Dockerfile'),
    'FROM scratch\nLABEL note=sk-ant-oat01-exampleexampleexampleexample\nCOPY motd /etc/motd\n',
  );

  await $`docker build --quiet --tag ${ctx.tag} ${ctx.contextPath}`.quiet();

  const result = await $`bash ${ctx.scriptPath} ${ctx.tag}`.nothrow().quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'check-no-secrets: the image history holds a token\n',
  });
});
