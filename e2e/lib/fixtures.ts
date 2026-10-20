import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listImageNames, runImp } from './imp-cli';
import { FIXTURES_DIR, REPO_ROOT } from './instance';
import type { FixtureImage } from './suites';

interface Build {
  readonly directory: string;
  readonly file?: string;

  // false for images/base: it is a real image, built under its own name
  readonly hashed: boolean;
}

const BUILDS: Readonly<Record<FixtureImage, Build>> = {
  base: { directory: join(REPO_ROOT, 'images', 'base'), hashed: false },
  'e2e-tiny': { directory: join(FIXTURES_DIR, 'tiny'), hashed: true },
  'e2e-bare': { directory: join(FIXTURES_DIR, 'tiny'), file: 'Dockerfile.bare', hashed: true },
  'e2e-ws': { directory: join(FIXTURES_DIR, 'ws'), hashed: true },
  'e2e-git': { directory: join(FIXTURES_DIR, 'git'), hashed: true },
  'e2e-ra': { directory: join(FIXTURES_DIR, 'ra'), hashed: true },
};

const names = new Map<FixtureImage, string>();

function readSourceHash(build: Build): string {
  const hash = createHash('sha256').update(build.file ?? 'Dockerfile');
  const paths = readdirSync(build.directory, { recursive: true, encoding: 'utf8' }).toSorted();

  for (const path of paths) {
    const full = join(build.directory, path);

    if (statSync(full).isFile()) {
      hash.update(`\0${path}\0`).update(readFileSync(full));
    }
  }

  return hash.digest('hex').slice(0, 8);
}

// A fixture image's name carries a hash of its sources, so a changed fixture
// builds anew instead of reusing an image impd already has.
export function resolveImageName(image: FixtureImage): string {
  const build = BUILDS[image];

  if (!build.hashed) {
    return image;
  }

  let name = names.get(image);

  if (name === undefined) {
    name = `${image}-${readSourceHash(build)}`;

    names.set(image, name);
  }

  return name;
}

// builds, through `impz image build`, each image impd does not have yet
export async function createMissingImages(images: readonly FixtureImage[]): Promise<void> {
  const existing = await listImageNames();

  const have = new Set(existing);

  for (const image of images) {
    const name = resolveImageName(image);

    if (have.has(name)) {
      continue;
    }

    const build = BUILDS[image];
    const fileArgs = build.file === undefined ? [] : ['--file', build.file];
    const started = Date.now();

    await runImp('image', 'build', build.directory, '--name', name, ...fileArgs);

    console.log(`    image ${name} built in ${String(Date.now() - started)} ms`);
  }
}
