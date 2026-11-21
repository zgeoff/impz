const GENERIC_BUG = /BUG: /u;
const KERNEL_BUG = /kernel BUG/u;
const RECORD_START = /usercopy: |cut here|kernel BUG|Oops: /u;
const OOPS = /kernel BUG|Oops: /u;
const ZFS_FRAME = /\[zfs\]/u;
const KEY_LINE = /usercopy: |kernel BUG|Oops: |Comm: |\[zfs\]/u;
const RECORD_END = /end trace/u;

interface KernelRecord {
  isOops: boolean;
  hasZfsFrame: boolean;
  readonly keyLines: string[];
}

// A record runs from its first report line to its end-trace line, so a ZFS warning beside an oops
// elsewhere is no ZFS oops. A generic `BUG:` report, such as a soft lockup, has no end-trace line:
// it closes any open record and opens none, so its frames never join a later oops.
export function parseZfsOops(log: string): readonly string[] {
  const found: string[] = [];
  let record: KernelRecord | null = null;

  for (const line of log.split('\n')) {
    if (GENERIC_BUG.test(line) && !KERNEL_BUG.test(line)) {
      found.push(...collectZfsOops(record));

      record = null;
      continue;
    }

    if (record === null && RECORD_START.test(line)) {
      record = { isOops: false, hasZfsFrame: false, keyLines: [] };
    }

    if (record === null) {
      continue;
    }

    record.isOops ||= OOPS.test(line);
    record.hasZfsFrame ||= ZFS_FRAME.test(line);

    if (KEY_LINE.test(line)) {
      record.keyLines.push(line);
    }

    if (RECORD_END.test(line)) {
      found.push(...collectZfsOops(record));

      record = null;
    }
  }

  found.push(...collectZfsOops(record));

  return found;
}

function collectZfsOops(record: KernelRecord | null): readonly string[] {
  return record !== null && record.isOops && record.hasZfsFrame ? record.keyLines : [];
}
