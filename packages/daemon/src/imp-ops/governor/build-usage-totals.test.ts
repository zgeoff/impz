import { expect, test } from 'bun:test';
import { buildUsageTotals } from './build-usage-totals';

test.each([
  ['an awake priority imp', [{ id: 'chat-a', hugePagesMib: 0, isPriority: true }], [], 100],
  [
    'an awake imp outside the patterns',
    [{ id: 'agent-a', hugePagesMib: 0, isPriority: false }],
    [],
    400,
  ],
  [
    'an admitted priority imp not awake yet',
    [],
    [{ id: 'chat-a', mib: 250, isPriority: true, isOnPool: false }],
    150,
  ],
])('it keeps the priority RAM less what %s uses', (_case, awake, reservations, keptMib) => {
  const totals = buildUsageTotals({
    awake,
    readings: [{ ramMib: 300, hugetlbMib: 0 }],
    reservations,
    lockedMib: 0,
    headroomMib: 0,
    priorityMib: 400,
  });

  expect(totals.keptMib).toBe(keptMib);
});

test('it keeps no priority RAM once priority imps use more than it', () => {
  const totals = buildUsageTotals({
    awake: [{ id: 'chat-a', hugePagesMib: 0, isPriority: true }],
    readings: [{ ramMib: 600, hugetlbMib: 0 }],
    reservations: [],
    lockedMib: 0,
    headroomMib: 0,
    priorityMib: 400,
  });

  expect(totals.keptMib).toBe(0);
});
