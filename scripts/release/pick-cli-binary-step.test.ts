import { expect, test } from 'bun:test';
import { pickCLIBinaryStep } from './pick-cli-binary-step';

test('it hashes the impz binary of the target first', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-arm64', 'impz-linux-x64'],
      sums: '',
      binarySum: null,
      reported: null,
    }),
  ).toStrictEqual({ kind: 'hash', name: 'impz-linux-x64' });
});

test('it hashes the imp binary of a tag from before the rename', () => {
  expect(
    pickCLIBinaryStep({
      target: 'darwin-arm64',
      version: '1.6.0',
      distFiles: ['SHA256SUMS', 'imp-darwin-arm64'],
      sums: '',
      binarySum: null,
      reported: null,
    }),
  ).toStrictEqual({ kind: 'hash', name: 'imp-darwin-arm64' });
});

test('it fails when dist/ holds no binary for the target', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-arm64'],
      sums: '',
      binarySum: null,
      reported: null,
    }),
  ).toStrictEqual({
    kind: 'fail',
    message: 'dist/ holds neither impz-linux-x64 nor imp-linux-x64',
  });
});

test('it fails a binary whose sum differs from the one SHA256SUMS lists', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-x64'],
      sums: `${'1'.repeat(64)}  impz-linux-x64\n`,
      binarySum: '2'.repeat(64),
      reported: null,
    }),
  ).toStrictEqual({
    kind: 'fail',
    message: `impz-linux-x64 has sha256 ${'2'.repeat(64)}, and SHA256SUMS lists ${'1'.repeat(64)} for it`,
  });
});

test('it fails a binary that SHA256SUMS leaves out', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-x64'],
      sums: `${'1'.repeat(64)}  impz-linux-arm64\n`,
      binarySum: '2'.repeat(64),
      reported: null,
    }),
  ).toStrictEqual({
    kind: 'fail',
    message: `impz-linux-x64 has sha256 ${'2'.repeat(64)}, and SHA256SUMS lists no sum for it`,
  });
});

test('it asks a binary whose sum matches for its version', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-x64'],
      sums: `${'2'.repeat(64)}  impz-linux-x64\n`,
      binarySum: '2'.repeat(64),
      reported: null,
    }),
  ).toStrictEqual({ kind: 'ask-version', name: 'impz-linux-x64' });
});

test('it fails a binary that reports another version', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-x64'],
      sums: `${'2'.repeat(64)}  impz-linux-x64\n`,
      binarySum: '2'.repeat(64),
      reported: '3.1.3\n',
    }),
  ).toStrictEqual({ kind: 'fail', message: 'impz-linux-x64 --version is 3.1.3, want 3.1.4' });
});

test('it checks every completion of a binary at its version', () => {
  expect(
    pickCLIBinaryStep({
      target: 'linux-x64',
      version: '3.1.4',
      distFiles: ['SHA256SUMS', 'impz-linux-x64'],
      sums: `${'2'.repeat(64)}  impz-linux-x64\n`,
      binarySum: '2'.repeat(64),
      reported: '3.1.4\n',
    }),
  ).toStrictEqual({
    kind: 'check-completions',
    name: 'impz-linux-x64',
    shells: ['bash', 'zsh', 'fish'],
    message: 'impz-linux-x64 is 3.1.4, matches SHA256SUMS and prints its completions',
  });
});
