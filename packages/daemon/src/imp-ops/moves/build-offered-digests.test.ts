import { expect, test } from 'bun:test';
import { buildOfferedDigests } from './build-offered-digests';

test('it offers the image digest alone when the source recorded no received digest', () => {
  expect(buildOfferedDigests('sha256:1111', null)).toStrictEqual(['sha256:1111']);
});

test('it offers the image digest and the received digest', () => {
  expect(buildOfferedDigests('sha256:1111', 'sha256:3333')).toStrictEqual([
    'sha256:1111',
    'sha256:3333',
  ]);
});
