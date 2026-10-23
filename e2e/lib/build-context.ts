import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Image } from '@impz/api';
import { createImpClient } from '@impz/client';

export async function writeBuildContext(
  root: string,
  name: string,
  dockerfile: string,
): Promise<string> {
  const directory = join(root, name);

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'Dockerfile'), dockerfile);

  return directory;
}

export interface RawBuild {
  readonly apiUrl: string;
  readonly token: string;
  readonly directoryPath: string;

  readonly files: readonly string[];
  readonly name: string;
}

// The CLI packs only the Dockerfile it is given, so the frontend's fallbacks
// need a tar built here.
export async function runRawBuild(build: Readonly<RawBuild>): Promise<Image> {
  const tar = Bun.spawn(['tar', '-C', build.directoryPath, '-cf', '-', ...build.files], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [body, stderr, exitCode] = await Promise.all([
    new Response(tar.stdout).blob(),
    new Response(tar.stderr).text(),
    tar.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`tar exited ${String(exitCode)}: ${stderr.trim()}`);
  }

  const client = createImpClient({ url: build.apiUrl, token: build.token });

  return client.buildImage(build.name, body);
}
