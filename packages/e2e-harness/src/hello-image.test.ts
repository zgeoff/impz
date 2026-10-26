// oxlint-disable-next-line zgeoff/test-beside-module -- it tests images/examples/hello/Dockerfile, a name with no extension that no test name can match
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('it starts from the published base, pinned by digest', () => {
  const froms = readFileSync(
    new URL('../../../images/examples/hello/Dockerfile', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => /^FROM\s/iv.test(line));

  expect(froms).toHaveLength(1);
  expect(froms[0]).toMatch(/^FROM ghcr\.io\/zgeoff\/imp-base:[\w.\-]+@sha256:[0-9a-f]{64}$/v);
});
