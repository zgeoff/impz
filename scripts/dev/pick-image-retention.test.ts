import { expect, test } from 'bun:test';
import { buildDevImageTag } from '../lib/build-dev-image-tag.ts';
import { pickImageRetention } from './pick-image-retention.ts';

test('it removes the own tag of a gone checkout on this machine that no container uses', () => {
  expect(
    pickImageRetention(
      {
        ref: buildDevImageTag('/w/gone'),
        labels: { worktree: '/w/gone', machine: 'machine-a' },
        isCheckoutLive: false,
        isInUse: false,
      },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'remove' });
});

test('it keeps an image whose labels it could not inspect', () => {
  expect(
    pickImageRetention(
      { ref: 'imp-host:dev-gone', labels: null, isCheckoutLive: false, isInUse: false },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'keep', reason: 'docker image inspect failed' });
});

test("it never touches a live checkout's image", () => {
  expect(
    pickImageRetention(
      {
        ref: buildDevImageTag('/w/live'),
        labels: { worktree: '/w/live', machine: 'machine-a' },
        isCheckoutLive: true,
        isInUse: false,
      },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'skip' });
});

test("it never touches another machine's image", () => {
  expect(
    pickImageRetention(
      {
        ref: buildDevImageTag('/w/gone'),
        labels: { worktree: '/w/gone', machine: 'machine-b' },
        isCheckoutLive: false,
        isInUse: false,
      },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'skip' });
});

test('it never touches an image whose worktree label is empty', () => {
  expect(
    pickImageRetention(
      {
        ref: 'imp-host:dev-x',
        labels: { worktree: '', machine: 'machine-a' },
        isCheckoutLive: false,
        isInUse: false,
      },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'skip' });
});

test("it keeps a tag that is not the gone checkout's own", () => {
  expect(
    pickImageRetention(
      {
        ref: 'imp-host:override',
        labels: { worktree: '/w/gone', machine: 'machine-a' },
        isCheckoutLive: false,
        isInUse: false,
      },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'keep', reason: 'not the tag of /w/gone' });
});

test('it keeps an image that a container uses', () => {
  expect(
    pickImageRetention(
      {
        ref: buildDevImageTag('/w/gone'),
        labels: { worktree: '/w/gone', machine: 'machine-a' },
        isCheckoutLive: false,
        isInUse: true,
      },
      'machine-a',
    ),
  ).toStrictEqual({ kind: 'keep', reason: 'a container uses it' });
});
