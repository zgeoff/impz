import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StubDockerImage {
  readonly id: string;
  readonly repoDigests: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

export function createStubDockerBin(
  directory: string,
  images: Readonly<Record<string, StubDockerImage>>,
) {
  const bin = join(directory, 'bin');
  const exports = join(directory, 'exports');
  const inspects = join(directory, 'inspect');
  const log = join(directory, 'docker.log');

  mkdirSync(bin, { recursive: true });
  mkdirSync(exports, { recursive: true });
  mkdirSync(inspects, { recursive: true });
  writeFileSync(log, '');

  const lines: string[] = [];

  for (const [ref, image] of Object.entries(images)) {
    const key = image.id.replace('sha256:', '');
    const tree = join(directory, 'trees', key);

    mkdirSync(tree, { recursive: true });

    for (const [name, content] of Object.entries(image.files)) {
      writeFileSync(join(tree, name), content);
    }

    Bun.spawnSync(['tar', '-C', tree, '-cf', join(exports, `${key}.tar`), '.']);

    writeFileSync(
      join(inspects, `${key}.json`),
      `${JSON.stringify([{ Id: image.id, Config: {}, Size: 1024, RepoDigests: image.repoDigests }])}\n`,
    );

    lines.push(`${ref} ${key}\n`);
  }

  writeFileSync(join(directory, 'images'), lines.join(''));
  copyFileSync(join(import.meta.dir, 'run-stub-docker.sh'), join(bin, 'docker'));
  chmodSync(join(bin, 'docker'), 0o755);

  return {
    binDir: bin,
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
