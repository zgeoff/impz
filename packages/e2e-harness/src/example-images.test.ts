// oxlint-disable-next-line zgeoff/test-beside-module -- it tests the Dockerfiles of images/examples, a name with no extension that no test name can match
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test.each(['hello', 'coder'])('it starts %s from the published base, pinned by digest', (name) => {
  const froms = readFileSync(
    new URL(`../../../images/examples/${name}/Dockerfile`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => /^FROM\s/iv.test(line));

  expect(froms).toHaveLength(1);
  expect(froms[0]).toMatch(/^FROM ghcr\.io\/zgeoff\/imp-base:[\w.\-]+@sha256:[0-9a-f]{64}$/v);
});

test('it checks each download of coder against its pinned sha256', () => {
  const dockerfile = readFileSync(
    new URL('../../../images/examples/coder/Dockerfile', import.meta.url),
    'utf8',
  );

  const downloads = Array.from(
    dockerfile.matchAll(/curl -\w*o \/tmp\/(?<file>\S+) /gv),
    (found) => found.groups?.['file'],
  );

  const checked = Array.from(
    dockerfile.matchAll(/echo "\$\w+_SHA256  \/tmp\/(?<file>\S+)" \| sha256sum -c -/gv),
    (found) => found.groups?.['file'],
  );

  expect(downloads).toStrictEqual(['claude', 'gh.tar.gz']);
  expect(checked).toStrictEqual(['claude', 'gh.tar.gz']);
  expect(dockerfile).toMatch(/^ARG CLAUDE_CODE_SHA256=[0-9a-f]{64}$/mv);
  expect(dockerfile).toMatch(/^ARG GH_SHA256=[0-9a-f]{64}$/mv);
});
