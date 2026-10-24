import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { checkDockerBuildx, runDockerBuild } from './run-docker-build';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'run-docker-build-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild exports the files a context directory builds into',
  async () => {
    const ctx = await setupTest();

    const context = join(ctx.directoryPath, 'context');

    await mkdir(context);
    await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
    await writeFile(join(context, 'app.js'), 'app');

    runDockerBuild({
      dockerfile: join(context, 'Dockerfile'),
      context: { directory: context },
      destination: join(ctx.directoryPath, 'out'),
    });

    expect(readFile(join(ctx.directoryPath, 'out', 'app.js'), 'utf8')).resolves.toBe('app');
  },
);

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild exports the files a context tar on stdin builds into',
  async () => {
    const ctx = await setupTest();

    const context = join(ctx.directoryPath, 'context');
    const tarPath = join(ctx.directoryPath, 'context.tar');

    await mkdir(context);
    await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
    await writeFile(join(context, 'app.js'), 'from the tar');

    const packed = Bun.spawnSync(['tar', '-cf', tarPath, '-C', context, '.']);

    invariant(packed.success);

    runDockerBuild({
      dockerfile: 'Dockerfile',
      context: { tarPath },
      destination: join(ctx.directoryPath, 'out'),
    });

    expect(readFile(join(ctx.directoryPath, 'out', 'app.js'), 'utf8')).resolves.toBe(
      'from the tar',
    );
  },
);

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild throws with docker’s message when the build fails',
  async () => {
    const ctx = await setupTest();

    const context = join(ctx.directoryPath, 'context');

    await mkdir(context);
    await writeFile(join(context, 'Dockerfile'), 'NOT A DOCKERFILE\n');

    expect(() => {
      runDockerBuild({
        dockerfile: join(context, 'Dockerfile'),
        context: { directory: context },
        destination: join(ctx.directoryPath, 'out'),
      });
    }).toThrowWithMessage(Error, /^docker buildx build --quiet -f .+unknown instruction/su);
  },
);
