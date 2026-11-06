import { expect, test } from 'bun:test';
import { isTemplateGoneError } from './is-template-gone-error';

test('it reports a missing file when the template is missing as a gone template', () => {
  const error = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });

  expect(isTemplateGoneError(error, false)).toBeTrue();
});

test.each([
  ['a missing file while the template exists', 'ENOENT', true],
  ['a refused permission', 'EACCES', false],
  ['a full disk', 'ENOSPC', false],
])('it reports %s as another error', (_, code, hasTemplate) => {
  const error = Object.assign(new Error(code), { code });

  expect(isTemplateGoneError(error, hasTemplate)).toBeFalse();
});
