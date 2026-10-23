import { expect, test } from 'bun:test';
import { formatFamiliarRepository, parseImageReference } from './parse-image-reference';

test.each([
  {
    reference: 'busybox',
    parsed: { registry: 'docker.io', path: 'library/busybox', tag: null, digest: null },
  },
  {
    reference: 'docker.io/library/busybox:1.36',
    parsed: { registry: 'docker.io', path: 'library/busybox', tag: '1.36', digest: null },
  },
  {
    reference: 'index.docker.io/library/busybox',
    parsed: { registry: 'docker.io', path: 'library/busybox', tag: null, digest: null },
  },
  {
    reference: 'ghcr.io/zgeoff/imp-host:latest',
    parsed: { registry: 'ghcr.io', path: 'zgeoff/imp-host', tag: 'latest', digest: null },
  },
  {
    reference: 'localhost:5000/x@sha256:ab',
    parsed: { registry: 'localhost:5000', path: 'x', tag: null, digest: 'sha256:ab' },
  },
  {
    reference: 'localhost:5000/x:2@sha256:ab',
    parsed: { registry: 'localhost:5000', path: 'x', tag: '2', digest: 'sha256:ab' },
  },
  {
    reference: 'LocalHost/name',
    parsed: { registry: 'LocalHost', path: 'name', tag: null, digest: null },
  },
  {
    reference: 'imp-host:dev',
    parsed: { registry: 'docker.io', path: 'library/imp-host', tag: 'dev', digest: null },
  },
  {
    reference: 'zgeoff/impz:1',
    parsed: { registry: 'docker.io', path: 'zgeoff/impz', tag: '1', digest: null },
  },
])('#parseImageReference reads $reference into its registry, path, tag and digest', (row) => {
  expect(parseImageReference(row.reference)).toStrictEqual(row.parsed);
});

test.each([
  ['busybox:1.37', 'busybox'],
  ['docker.io/library/busybox', 'busybox'],
  ['library/busybox', 'busybox'],
  ['index.docker.io/zgeoff/impz', 'zgeoff/impz'],
  ['docker.io/library/a/b', 'library/a/b'],
  ['ghcr.io/zgeoff/imp-base@sha256:ab', 'ghcr.io/zgeoff/imp-base'],
  ['localhost:5000/x:1', 'localhost:5000/x'],
  ['registry.test:5000/app:1', 'registry.test:5000/app'],
  ['localhost/app', 'localhost/app'],
  ['LocalHost/app:1', 'LocalHost/app'],
])('#formatFamiliarRepository writes %s as RepoDigests does, %s', (reference, repository) => {
  expect(formatFamiliarRepository(parseImageReference(reference))).toBe(repository);
});
