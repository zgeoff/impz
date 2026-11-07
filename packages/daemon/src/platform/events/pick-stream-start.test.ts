import { expect, test } from 'bun:test';
import { pickStreamStart } from './pick-stream-start';

test.each([
  { title: 'a snapshot with no cursor', cursor: {}, start: { kind: 'snapshot' } },
  {
    title: 'a snapshot for a log ID alone',
    cursor: { logId: 'log-a' },
    start: { kind: 'snapshot' },
  },
  {
    title: 'a resume at the head',
    cursor: { after: 40, logId: 'log-a' },
    start: { kind: 'resume', after: 40 },
  },
  {
    title: 'a resume behind the head',
    cursor: { after: 12, logId: 'log-a' },
    start: { kind: 'resume', after: 12 },
  },
  {
    title: 'a resume for a cursor with no log ID',
    cursor: { after: 12 },
    start: { kind: 'resume', after: 12 },
  },
  {
    title: 'a reset for another log ID',
    cursor: { after: 12, logId: 'log-b' },
    start: { kind: 'reset' },
  },
  { title: 'a reset for a cursor past the head', cursor: { after: 41 }, start: { kind: 'reset' } },
])('it picks $title', (row) => {
  expect(pickStreamStart(row.cursor, { head: 40, logId: 'log-a' })).toStrictEqual(row.start);
});
