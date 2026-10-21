import { expect, test } from 'bun:test';
import { probeUpdateReadOnly } from './probe-update-read-only';

// Only root's lock needs chattr +i, which this machine may refuse; another
// user's lock is a chmod.
test.skipIf(
  process.getuid?.() === 0 &&
    Bun.spawnSync([
      'sh',
      '-c',
      'd=$(mktemp -d) && chattr +i "$d" && chattr -i "$d"; s=$?; rm -rf "$d"; exit $s',
    ]).exitCode !== 0,
)('it answers yes where the run can lock a tree', () => {
  expect(probeUpdateReadOnly()).toBeTrue();
});
