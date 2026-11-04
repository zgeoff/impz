import { expect, test } from 'bun:test';
import { isTemplateGoneError } from './is-template-gone-error';

test('it reports a missing file beside an existing destination folder as a gone template', () => {
  const error = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });

  expect(isTemplateGoneError(error, true)).toBeTrue();
});

test.each([
  ['a missing destination folder', 'ENOENT', false],
  ['a refused permission', 'EACCES', true],
  ['a full disk', 'ENOSPC', true],
])('it reports %s as another error', (_, code, hasDestinationDirectory) => {
  const error = Object.assign(new Error(code), { code });

  expect(isTemplateGoneError(error, hasDestinationDirectory)).toBeFalse();
});
