import { expect, test } from 'bun:test';
import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { isStepEvent } from './is-step-event';

test('it matches the wake event of the imp that the timed wake returned', () => {
  const woken = buildMockImp({ id: 'imp-7', resources: { wakeCount: 2, awakeMs: 40 } });

  const event: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: woken,
  };

  expect(isStepEvent(event, 'woke', woken)).toBe(true);
});

test("it never matches the arrange's earlier wake of the same imp", () => {
  const woken = buildMockImp({ id: 'imp-7', resources: { wakeCount: 2, awakeMs: 40 } });

  const event: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: { ...woken, resources: { wakeCount: 1, awakeMs: 20 } },
  };

  expect(isStepEvent(event, 'woke', woken)).toBe(false);
});

test('it never matches an earlier sleep of the same imp', () => {
  const slept = buildMockImp({ id: 'imp-7', sleptAt: new Date('2026-03-04T05:06:08.000Z') });

  const event: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'slept',
    imp: { ...slept, sleptAt: new Date('2026-03-04T05:06:07.000Z') },
  };

  expect(isStepEvent(event, 'slept', slept)).toBe(false);
});

test('it never matches the boot of an earlier imp of the same name', () => {
  const created = buildMockImp({ id: 'imp-8', name: 'bench-a' });

  const event: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: { ...created, id: 'imp-3' },
  };

  expect(isStepEvent(event, 'booted', created)).toBe(false);
});
