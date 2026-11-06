import { expect, test } from 'bun:test';
import { buildUsageTotals } from './build-usage-totals';

test.each([
  [
    'an awake priority imp on 4 KiB pages',
    [{ id: 'chat-a', hugePagesMib: 0, isPriority: true }],
    [],
    { ramMib: 100, ordinaryMib: 100, poolMib: 400 },
  ],
  [
    'an awake priority imp on 2 MiB pages',
    [{ id: 'chat-a', hugePagesMib: 256, isPriority: true }],
    [],
    { ramMib: 100, ordinaryMib: 400, poolMib: 144 },
  ],
  [
    'an awake imp outside the patterns',
    [{ id: 'agent-a', hugePagesMib: 0, isPriority: false }],
    [],
    { ramMib: 400, ordinaryMib: 400, poolMib: 400 },
  ],
  [
    'an admitted priority imp on 2 MiB pages not awake yet',
    [],
    [{ id: 'chat-a', mib: 250, isPriority: true, poolMib: 256 }],
    { ramMib: 150, ordinaryMib: 400, poolMib: 144 },
  ],
])(
  'it keeps the priority RAM in each budget less what %s uses there',
  (_case, awake, reservations, kept) => {
    const totals = buildUsageTotals({
      awake,
      readings: [{ ramMib: 300, hugetlbMib: 300 }],
      reservations,
      lockedMib: 0,
      headroomMib: 0,
      priorityMib: 400,
    });

    expect(totals.kept).toStrictEqual(kept);
  },
);

test('it keeps no priority RAM once priority imps use more than it', () => {
  const totals = buildUsageTotals({
    awake: [{ id: 'chat-a', hugePagesMib: 0, isPriority: true }],
    readings: [{ ramMib: 600, hugetlbMib: 0 }],
    reservations: [],
    lockedMib: 0,
    headroomMib: 0,
    priorityMib: 400,
  });

  expect(totals.kept).toStrictEqual({ ramMib: 0, ordinaryMib: 0, poolMib: 400 });
});
