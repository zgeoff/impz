import { expect, test } from 'bun:test';
import { buildUsageTotals } from './build-usage-totals';

test.each([
  {
    holder: 'an awake priority imp on 4 KiB pages',
    awake: [{ id: 'chat-a', hugePagesMib: 0, isPriority: true }],
    reservations: [],
    pendingPool: [],
    kept: { ramMib: 100, ordinaryMib: 100, poolMib: 400 },
  },
  {
    holder: 'an awake priority imp on 2 MiB pages',
    awake: [{ id: 'chat-a', hugePagesMib: 256, isPriority: true }],
    reservations: [],
    pendingPool: [],
    kept: { ramMib: 100, ordinaryMib: 400, poolMib: 144 },
  },
  {
    holder: 'an awake imp outside the patterns',
    awake: [{ id: 'agent-a', hugePagesMib: 0, isPriority: false }],
    reservations: [],
    pendingPool: [],
    kept: { ramMib: 400, ordinaryMib: 400, poolMib: 400 },
  },
  {
    holder: 'an admitted priority imp on 2 MiB pages not awake yet',
    awake: [],
    reservations: [{ id: 'chat-a', mib: 250, isPriority: true, isOnPool: true }],
    pendingPool: [{ id: 'chat-a', mib: 256, isPriority: true }],
    kept: { ramMib: 150, ordinaryMib: 400, poolMib: 144 },
  },
  {
    holder: 'an admitted priority imp on 2 MiB pages whose RAM reservation expired',
    awake: [],
    reservations: [],
    pendingPool: [{ id: 'chat-a', mib: 256, isPriority: true }],
    kept: { ramMib: 400, ordinaryMib: 400, poolMib: 144 },
  },
])('it keeps the priority RAM in each budget less what $holder uses there', (row) => {
  const totals = buildUsageTotals({
    awake: row.awake,
    readings: [{ ramMib: 300, hugetlbMib: 300 }],
    reservations: row.reservations,
    pendingPool: row.pendingPool,
    lockedMib: 0,
    headroomMib: 0,
    priorityMib: 400,
  });

  expect(totals.kept).toStrictEqual(row.kept);
});

test('it keeps no priority RAM once priority imps use more than it', () => {
  const totals = buildUsageTotals({
    awake: [{ id: 'chat-a', hugePagesMib: 0, isPriority: true }],
    readings: [{ ramMib: 600, hugetlbMib: 0 }],
    reservations: [],
    pendingPool: [],
    lockedMib: 0,
    headroomMib: 0,
    priorityMib: 400,
  });

  expect(totals.kept).toStrictEqual({ ramMib: 0, ordinaryMib: 0, poolMib: 400 });
});
