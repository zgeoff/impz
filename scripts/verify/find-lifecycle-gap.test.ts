import { expect, test } from 'bun:test';
import { findLifecycleGap } from './find-lifecycle-gap.ts';

test('it finds no gap in an imp added, run, slept and removed', () => {
  const events = [
    { ev: 'ImpAdded', reason: 'created', state: 'creating' },
    { ev: 'ImpChanged', reason: 'booted', state: 'running' },
    { ev: 'ImpChanged', reason: 'slept', state: 'sleeping' },
    { ev: 'ImpRemoved', reason: null, state: 'sleeping' },
  ];

  expect(findLifecycleGap(events)).toBeNull();
});

test.each([
  {
    missing: 'the add',
    events: [
      { ev: 'ImpChanged', reason: 'booted', state: 'running' },
      { ev: 'ImpChanged', reason: 'slept', state: 'sleeping' },
      { ev: 'ImpRemoved', reason: null, state: 'sleeping' },
    ],
    gap: 'an ImpAdded event, reason created',
  },
  {
    missing: 'the run',
    events: [
      { ev: 'ImpAdded', reason: 'created', state: 'creating' },
      { ev: 'ImpChanged', reason: 'slept', state: 'sleeping' },
      { ev: 'ImpRemoved', reason: null, state: 'sleeping' },
    ],
    gap: 'an ImpChanged event to running',
  },
  {
    missing: 'the sleep',
    events: [
      { ev: 'ImpAdded', reason: 'created', state: 'creating' },
      { ev: 'ImpChanged', reason: 'booted', state: 'running' },
      { ev: 'ImpRemoved', reason: null, state: 'running' },
    ],
    gap: 'an ImpChanged event to sleeping, reason slept',
  },
  {
    missing: 'the removal',
    events: [
      { ev: 'ImpAdded', reason: 'created', state: 'creating' },
      { ev: 'ImpChanged', reason: 'booted', state: 'running' },
      { ev: 'ImpChanged', reason: 'slept', state: 'sleeping' },
    ],
    gap: 'an ImpRemoved event',
  },
  {
    missing: 'the order',
    events: [
      { ev: 'ImpChanged', reason: 'booted', state: 'running' },
      { ev: 'ImpAdded', reason: 'created', state: 'creating' },
      { ev: 'ImpChanged', reason: 'slept', state: 'sleeping' },
      { ev: 'ImpRemoved', reason: null, state: 'sleeping' },
    ],
    gap: 'an ImpChanged event to running',
  },
])('it names the first step the events lack: $missing', (row) => {
  expect(findLifecycleGap(row.events)).toBe(row.gap);
});
