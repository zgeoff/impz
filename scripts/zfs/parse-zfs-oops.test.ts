import { expect, test } from 'bun:test';
import { parseZfsOops } from './parse-zfs-oops.ts';

test('it keeps the key lines of a usercopy oops whose trace runs through ZFS', () => {
  expect(
    parseZfsOops(`[  80.100000] eth0: link up
[  90.200000] usercopy: Kernel memory exposure attempt detected from SLUB object 'zio_buf_comb_16384' (offset 12288, size 20480)!
[  90.200050] ------------[ cut here ]------------
[  90.200100] kernel BUG at mm/usercopy.c:102!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200300] CPU: 0 UID: 900000 PID: 4242 Comm: firecracker Tainted: P O 6.17.0-1-azure
[  90.200400] RIP: 0010:usercopy_abort+0x6c/0x80
[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]
[  90.200600]  zfs_read+0x3c8/0x500 [zfs]
[  90.200700]  vfs_read+0x24d/0x370
[  90.200800] ---[ end trace 0000000000000000 ]---
[  90.200900] RIP: 0010:usercopy_abort+0x6c/0x80
`),
  ).toStrictEqual([
    "[  90.200000] usercopy: Kernel memory exposure attempt detected from SLUB object 'zio_buf_comb_16384' (offset 12288, size 20480)!",
    '[  90.200100] kernel BUG at mm/usercopy.c:102!',
    '[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI',
    '[  90.200300] CPU: 0 UID: 900000 PID: 4242 Comm: firecracker Tainted: P O 6.17.0-1-azure',
    '[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]',
    '[  90.200600]  zfs_read+0x3c8/0x500 [zfs]',
  ]);
});

test('it keeps the key lines of a page-fault oops that a generic BUG line opens', () => {
  expect(
    parseZfsOops(`[  90.200000] BUG: unable to handle page fault for address: ffffa0b1c0000000
[  90.200100] #PF: supervisor read access in kernel mode
[  90.200200] Oops: 0000 [#1] SMP NOPTI
[  90.200300] CPU: 1 UID: 900000 PID: 4343 Comm: firecracker Tainted: P O 6.17.0-1-azure
[  90.200400]  zfs_read+0x3c8/0x500 [zfs]
[  90.200500] ---[ end trace 0000000000000000 ]---
`),
  ).toStrictEqual([
    '[  90.200200] Oops: 0000 [#1] SMP NOPTI',
    '[  90.200300] CPU: 1 UID: 900000 PID: 4343 Comm: firecracker Tainted: P O 6.17.0-1-azure',
    '[  90.200400]  zfs_read+0x3c8/0x500 [zfs]',
  ]);
});

test('it finds no ZFS oops when an oops outside ZFS sits beside a ZFS warning', () => {
  expect(
    parseZfsOops(`[  90.200050] ------------[ cut here ]------------
[  90.200100] kernel BUG at mm/slub.c:500!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200500]  kmem_cache_free+0x10/0x40
[  90.200600] ---[ end trace 0000000000000000 ]---
[  95.300000] ------------[ cut here ]------------
[  95.300100] WARNING: CPU: 1 PID: 77 at module/zfs/txg.c:600 txg_wait_synced+0x20/0x40 [zfs]
[  95.300200]  txg_wait_synced+0x20/0x40 [zfs]
[  95.300300] ---[ end trace 0000000000000000 ]---
`),
  ).toStrictEqual([]);
});

test('it finds no ZFS oops when a ZFS soft lockup closes an open record before an oops outside ZFS', () => {
  expect(
    parseZfsOops(`[  80.000000] ------------[ cut here ]------------
[  80.100000] watchdog: BUG: soft lockup - CPU#2 stuck for 26s! [z_wr_iss:812]
[  80.100100] CPU: 2 UID: 0 PID: 812 Comm: z_wr_iss Tainted: P O 6.17.0-1-azure
[  80.100200]  zio_execute+0x90/0x130 [zfs]
[  80.100300]  taskq_thread+0x2a0/0x4d0 [spl]
[  90.200100] kernel BUG at mm/slub.c:500!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200500]  kmem_cache_free+0x10/0x40
[  90.200600] ---[ end trace 0000000000000000 ]---
`),
  ).toStrictEqual([]);
});

test('it keeps a ZFS oops that the log ends before its end-trace line', () => {
  expect(
    parseZfsOops(`[  90.200100] kernel BUG at mm/usercopy.c:102!
[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]`),
  ).toStrictEqual([
    '[  90.200100] kernel BUG at mm/usercopy.c:102!',
    '[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]',
  ]);
});

test('it finds no ZFS oops in a log without one', () => {
  expect(parseZfsOops('[  12.000000] eth0: link up\n')).toStrictEqual([]);
});
