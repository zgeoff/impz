import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('it refuses to start without IMP_HOST_IMAGE', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: '' },
  });

  expect(result.exitCode).not.toBe(0);

  expect(result.stderr.toString()).toInclude(
    'IMP_HOST_IMAGE is not set; set it to the image this proxy runs from',
  );
});

test('it refuses to start with an IMP_BUILD_IMAGE that names no digest', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: 'x', IMP_BUILD_IMAGE: 'busybox:1.37' },
  });

  expect(result.exitCode).not.toBe(0);

  expect(result.stderr.toString()).toInclude(
    'IMP_BUILD_IMAGE is busybox:1.37, not an image by digest, <ref>@sha256:<hex>',
  );
});
