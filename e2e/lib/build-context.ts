import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_BUILD_PATH } from '@impz/api';

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
export async function sendRawBuild(build: Readonly<RawBuild>): Promise<Response> {
  const tar = Bun.spawn(['tar', '-C', build.directoryPath, '-cf', '-', ...build.files], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [body, stderr, exitCode] = await Promise.all([
    new Response(tar.stdout).arrayBuffer(),
    new Response(tar.stderr).text(),
    tar.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`tar exited ${String(exitCode)}: ${stderr.trim()}`);
  }

  const url = new URL(IMAGE_BUILD_PATH, build.apiUrl);

  url.searchParams.set('name', build.name);

  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${build.token}`, 'content-type': 'application/x-tar' },
    body,
  });
}
