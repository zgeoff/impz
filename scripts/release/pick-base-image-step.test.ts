import { expect, test } from 'bun:test';
import { pickBaseImageStep } from './pick-base-image-step';

test('it skips a tree without the check script, with a notice', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: false,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: null,
      verified: null,
    }),
  ).toStrictEqual({
    kind: 'finish',
    action: 'skip',
    notice:
      'this tree predates the published imp-base, so ghcr.io/example/imp-base:1.2.3 is not built',
  });
});

test('it skips a tree whose base image is unpinned', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nRUN apt-get install -y docker-ce\n',
      inspected: null,
      verified: null,
    }),
  ).toStrictEqual({
    kind: 'finish',
    action: 'skip',
    notice:
      'this tree predates the published imp-base, so ghcr.io/example/imp-base:1.2.3 is not built',
  });
});

test('it asks the registry first about a pinned tree', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: null,
      verified: null,
    }),
  ).toStrictEqual({ kind: 'inspect' });
});

test('it pushes a tag the registry reports as not found', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: {
        exitCode: 1,
        stdout: '',
        stderr: 'ERROR: ghcr.io/example/imp-base:1.2.3: not found\n',
      },
      verified: null,
    }),
  ).toStrictEqual({ kind: 'finish', action: 'push', notice: null });
});

test('it fails when the registry refuses to say whether the tag exists', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: { exitCode: 1, stdout: '', stderr: 'ERROR: 403 Forbidden\n' },
      verified: null,
    }),
  ).toStrictEqual({
    kind: 'fail',
    stderr: 'cannot tell whether ghcr.io/example/imp-base:1.2.3 exists:\nERROR: 403 Forbidden\n',
    error: null,
  });
});

test('it fails on an existing tag whose digest is not a sha256', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: { exitCode: 0, stdout: 'sha512:abc\n', stderr: '' },
      verified: null,
    }),
  ).toStrictEqual({
    kind: 'fail',
    stderr: '',
    error:
      'ghcr.io/example/imp-base:1.2.3 exists, but the registry gave no valid digest: sha512:abc',
  });
});

test('it verifies the attestation of an existing tag at its digest', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: { exitCode: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' },
      verified: null,
    }),
  ).toStrictEqual({ kind: 'verify', digest: `sha256:${'a'.repeat(64)}` });
});

test('it fails on an existing tag without an attestation from the repository', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: { exitCode: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' },
      verified: { exitCode: 1, stdout: 'Loaded 0 attestations\n', stderr: 'no match\n' },
    }),
  ).toStrictEqual({
    kind: 'fail',
    stderr: 'Loaded 0 attestations\nno match\n',
    error: `ghcr.io/example/imp-base:1.2.3 exists at sha256:${'a'.repeat(64)} with no attestation from example/impz; treat it as a possible compromise (docs/runbooks/releasing.md)`,
  });
});

test('it leaves an attested existing tag alone, with a notice', () => {
  expect(
    pickBaseImageStep({
      ref: 'ghcr.io/example/imp-base:1.2.3',
      repository: 'example/impz',
      hasCheckScript: true,
      dockerfile: 'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1\n',
      inspected: { exitCode: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' },
      verified: { exitCode: 0, stdout: 'Verification succeeded\n', stderr: '' },
    }),
  ).toStrictEqual({
    kind: 'finish',
    action: 'skip',
    notice: `ghcr.io/example/imp-base:1.2.3 exists already at sha256:${'a'.repeat(64)}, attested; a published imp-base never moves, so this run leaves it alone`,
  });
});
