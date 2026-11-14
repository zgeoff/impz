import { expect, test } from 'bun:test';
import { pickGateStep } from './pick-gate-step.ts';

test('it gates a pull request on its base branch and body', () => {
  const event = {
    pull_request: {
      body: 'the report',
      base: { ref: 'main' },
      head: { ref: 'add-orchard-view' },
      user: { login: 'orchard-keeper', type: 'User' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: 'the report' });
});

test('it gates a pull request with no body on an empty one', () => {
  const event = {
    pull_request: {
      body: null,
      base: { ref: 'main' },
      head: { ref: 'add-orchard-view' },
      user: { login: 'orchard-keeper', type: 'User' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: '' });
});

test.each([
  {
    who: 'the release pull request the release bot opens',
    login: 'zgeoff-release-bot[bot]',
    ref: 'release-please--branches--main--components--impz',
    reason: 'a release pull request carries no verify report',
  },
  {
    who: 'a dependency pull request the Renovate bot opens',
    login: 'zgeoff-renovate[bot]',
    ref: 'renovate/left-pad-2.x',
    reason: 'a renovate pull request carries no verify report',
  },
])('it skips $who', (row) => {
  const event = {
    pull_request: {
      body: 'update left-pad to v2',
      base: { ref: 'main' },
      head: { ref: row.ref },
      user: { login: row.login, type: 'Bot' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'skip', reason: row.reason });
});

test.each([
  {
    who: 'a person on the release branch',
    login: 'orchard-keeper',
    type: 'User',
    ref: 'release-please--branches--main--components--impz',
  },
  {
    who: 'a person on a renovate branch',
    login: 'orchard-keeper',
    type: 'User',
    ref: 'renovate/x',
  },
  {
    who: 'a person whose login is the Renovate bot',
    login: 'zgeoff-renovate[bot]',
    type: 'User',
    ref: 'renovate/left-pad-2.x',
  },
  {
    who: 'another bot on a renovate branch',
    login: 'orchard-bot[bot]',
    type: 'Bot',
    ref: 'renovate/left-pad-2.x',
  },
  {
    who: 'the Renovate bot on a branch of another name',
    login: 'zgeoff-renovate[bot]',
    type: 'Bot',
    ref: 'update-left-pad',
  },
  {
    who: 'the release bot on another release branch',
    login: 'zgeoff-release-bot[bot]',
    type: 'Bot',
    ref: 'release-please--branches--main',
  },
])('it gates $who', (row) => {
  const event = {
    pull_request: {
      body: '',
      base: { ref: 'main' },
      head: { ref: row.ref },
      user: { login: row.login, type: row.type },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: '' });
});

test('it refuses an event with no pull request', () => {
  expect(pickGateStep({ ref: 'refs/heads/main' })).toMatchObject({ kind: 'refused' });
});
