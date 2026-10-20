import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildImagePaths,
  buildImagesDir,
  buildImpPaths,
  buildImpsDir,
  createDataDirs,
  toDigestHex,
} from './data-layout';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-data-layout-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('#buildImpsDir puts the imps directory under the data dir', () => {
  expect(buildImpsDir('/var/lib/imp')).toBe('/var/lib/imp/imps');
});

test('#buildImagesDir puts the images directory under the data dir', () => {
  expect(buildImagesDir('/var/lib/imp')).toBe('/var/lib/imp/images');
});

test.each([
  ['a prefixed digest', 'sha256:3f1a', '3f1a'],
  ['a bare digest', '3f1a', '3f1a'],
  ['a digest with sha256: past its start', '3f1asha256:', '3f1asha256:'],
])('#toDigestHex strips the prefix of %s', (_label, digest, expected) => {
  expect(toDigestHex(digest)).toBe(expected);
});

test('#buildImagePaths names the image directory by its bare digest', () => {
  expect(buildImagePaths('/var/lib/imp', 'sha256:3f1a')).toStrictEqual({
    directory: '/var/lib/imp/images/3f1a',
    rootfs: '/var/lib/imp/images/3f1a/rootfs.ext4',
    config: '/var/lib/imp/images/3f1a/config.json',
  });
});

test('#buildImpPaths puts the imp directory under the imps directory', () => {
  expect(buildImpPaths('/var/lib/imp', 'imp-1').directory).toBe('/var/lib/imp/imps/imp-1');
});

test('#createDataDirs makes the database, system, images and imps directories', async () => {
  const ctx = await setupTest();

  createDataDirs(join(ctx.directoryPath, 'data'));

  expect(readdirSync(join(ctx.directoryPath, 'data')).toSorted()).toStrictEqual([
    'db',
    'images',
    'imps',
    'system',
  ]);

  expect(statSync(join(ctx.directoryPath, 'data', 'db')).isDirectory()).toBe(true);
  expect(statSync(join(ctx.directoryPath, 'data', 'system')).isDirectory()).toBe(true);
  expect(statSync(join(ctx.directoryPath, 'data', 'images')).isDirectory()).toBe(true);
  expect(statSync(join(ctx.directoryPath, 'data', 'imps')).isDirectory()).toBe(true);
});

test('#createDataDirs keeps the directories and files a data dir already holds', async () => {
  const ctx = await setupTest();

  createDataDirs(ctx.directoryPath);
  writeFileSync(join(ctx.directoryPath, 'db', 'imp.sqlite'), 'database');
  createDataDirs(ctx.directoryPath);

  expect(readFileSync(join(ctx.directoryPath, 'db', 'imp.sqlite'), 'utf8')).toBe('database');

  expect(readdirSync(ctx.directoryPath).toSorted()).toStrictEqual([
    'db',
    'images',
    'imps',
    'system',
  ]);
});
