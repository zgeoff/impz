import { expect, test } from 'bun:test';
import { buildDevImageTag } from './build-dev-image-tag.ts';

test('it gives a checkout the same tag every time', () => {
  expect(buildDevImageTag('/a/imp')).toBe(buildDevImageTag('/a/imp'));
});

test('it gives another checkout of the same name another tag', () => {
  expect(buildDevImageTag('/a/imp')).not.toBe(buildDevImageTag('/b/imp'));
});

test('it names the tag for the checkout and the first 8 hex of its path hash', () => {
  expect(buildDevImageTag('/a/imp')).toBe('imp-host:dev-imp-dec5da88');
});

test.each([['/w/My Work Tree'], ['/w/.hidden'], ['/w/wörk'], [`/w/${'x'.repeat(200)}`]])(
  'it keeps the tag of %p to the characters and length Docker allows',
  (root) => {
    expect(buildDevImageTag(root)).toMatch(/^imp-host:dev-[A-Za-z0-9_.-]{1,40}-[0-9a-f]{8}$/u);
  },
);

test('it turns the blanks of a checkout name into dashes', () => {
  expect(buildDevImageTag('/w/My Work Tree')).toStartWith('imp-host:dev-My-Work-Tree-');
});

test('it turns each byte of a non-ASCII character into one dash', () => {
  expect(buildDevImageTag('/w/wörk')).toStartWith('imp-host:dev-w--rk-');
});

test('it cuts a long checkout name to 40 characters', () => {
  expect(buildDevImageTag(`/w/${'x'.repeat(200)}`)).toStartWith(`imp-host:dev-${'x'.repeat(40)}-`);
});
