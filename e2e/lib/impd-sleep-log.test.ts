import { expect, test } from 'bun:test';
import { findAsleepLine } from './impd-sleep-log';

test('it reads the duration, plugged size and steps of the newest sleep of the imp', () => {
  const log = [
    'impd: e2e-mem-grow: asleep in 812ms (idle), ram 300 MiB, 512 MiB plugged, mem file 290 MiB on disk, pause=3ms snapshot=700ms',
    'impd: e2e-mem-grow: woke pid 42 in 120ms spawn=20ms load=80ms',
    'impd: e2e-mem-grow: asleep in 640ms (api), ram 210 MiB, 188 MiB plugged, mem file 200 MiB on disk, copyBase=40ms pause=2ms snapshot=90ms',
    '',
  ].join('\n');

  expect(findAsleepLine(log, 'e2e-mem-grow')).toStrictEqual({
    ms: 640,
    pluggedMib: 188,
    steps: { copyBase: 40, pause: 2, snapshot: 90 },
  });
});

test('it reads no plugged size from the sleep of an imp without elastic memory', () => {
  const log =
    'impd: e2e-mem-a: asleep in 500ms (api), ram 120 MiB, mem file 100 MiB on disk, pause=2ms\n';

  expect(findAsleepLine(log, 'e2e-mem-a')).toStrictEqual({
    ms: 500,
    pluggedMib: null,
    steps: { pause: 2 },
  });
});

test('it ignores the sleep of an imp whose name only starts with the one it looks for', () => {
  const log =
    'impd: e2e-mem-grow2: asleep in 500ms (api), ram 120 MiB, 256 MiB plugged, mem file 100 MiB on disk, pause=2ms\n';

  expect(findAsleepLine(log, 'e2e-mem-grow')).toBeNull();
});

test('it throws on a sleep line with no duration', () => {
  expect(() => findAsleepLine('impd: e2e-mem-a: asleep in soon\n', 'e2e-mem-a')).toThrowWithMessage(
    Error,
    'no duration in "impd: e2e-mem-a: asleep in soon"',
  );
});
