import { expect, test } from 'bun:test';
import { buildDigestTag } from './build-digest-tag';

test.each([
  ['sha256:9f2c1a0b77', '9f2c1a0b'],
  ['imp-0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b', '3e4f5a6b'],
])('#buildDigestTag tags %s as %s', (digest, tag) => {
  expect(buildDigestTag(digest)).toBe(tag);
});
