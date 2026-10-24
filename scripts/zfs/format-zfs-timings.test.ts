import { expect, test } from 'bun:test';
import { formatZfsTimings } from './format-zfs-timings.ts';

test('it summarizes the timings in impd’s log and the suites’ metrics', () => {
  expect(
    formatZfsTimings({
      impdLog: `INFO impd.imps imp=imp-a checkpoint cp-1a in 120ms
INFO impd.imps imp=imp-a checkpoint cp-2b in 80ms
INFO impd.imps imp=imp-b checkpoint cp-3c in 300ms
INFO impd.imps imp=imp-a restored cp-1a in 45ms
INFO impd.imps imp=imp-a disk cloned in 7ms
INFO impd.imps imp=imp-a asleep in 900ms
INFO impd.imps imp=imp-a mem file 512 MiB on disk
INFO impd.imps imp=imp-b mem file 256 MiB on disk
INFO impd.imps imp=imp-c mem file 512 MiB on disk
`,
      e2eLog: `checkpoints suite
  checkpointMs: 130
  wakeOnHttpMs: 41
  backupUploadMs: 900
  bootTemplateRestoreP50Ms: 62
  otherMs: 5
checkpointMs: 7
`,
    }),
  ).toMatchInlineSnapshot(`
    "zfs-host-test: impd timings on ZFS
    checkpoint             n=3  min 80  median 120  max 300 ms
    restore                n=1  min 45  median 45  max 45 ms
    disk clone (new/fork)  n=1  min 7  median 7  max 7 ms
    sleep                  n=1  min 900  median 900  max 900 ms
          1 mem file 256 MiB on disk
          2 mem file 512 MiB on disk

    zfs-host-test: the suites' own metrics, CLI round trip included
      checkpointMs: 130
      wakeOnHttpMs: 41
      backupUploadMs: 900
      bootTemplateRestoreP50Ms: 62

    "
  `);
});

test('it says a timing has no samples when impd’s log holds none', () => {
  expect(formatZfsTimings({ impdLog: '', e2eLog: '' })).toBe(
    `zfs-host-test: impd timings on ZFS
checkpoint             no samples
restore                no samples
disk clone (new/fork)  no samples
sleep                  no samples

zfs-host-test: the suites' own metrics, CLI round trip included

`,
  );
});

test('it takes the lower middle value as the median of an even count', () => {
  expect(
    formatZfsTimings({
      impdLog:
        'disk cloned in 40ms\ndisk cloned in 10ms\ndisk cloned in 30ms\ndisk cloned in 20ms\n',
      e2eLog: '',
    }),
  ).toInclude('disk clone (new/fork)  n=4  min 10  median 20  max 40 ms\n');
});
