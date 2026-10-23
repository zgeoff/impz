import { expect, test } from 'bun:test';
import { parseKernelState } from './parse-kernel-state';

test('it keeps the vm and kernel sysctls in order and the bootstrap modules sorted', () => {
  expect(
    parseKernelState({
      sysctl: [
        'vm.swappiness = 60',
        'net.ipv4.ip_forward = 1',
        'kernel.pid_max = 4194304',
        'kernel.random.entropy_avail = 256',
        'kernel.ns_last_pid = 4021',
        'kernel.pty.nr = 3',
        'kernel.sched_domain.cpu0.domain0.flags = 4655',
        'kernel.perf_event_max_sample_rate = 100000',
        'kernel.tainted = 0',
        'kernel.spl.kmem.slab_kvmem_total = 1',
        'vm.overcommit_memory = 0',
        '',
      ].join('\n'),
      modules: [
        'tun 61440 0 - Live 0x0000000000000000',
        'xfs 2289664 1 - Live 0x0000000000000000',
        'kvm_intel 409600 0 - Live 0x0000000000000000',
        'kvm 1155072 1 kvm_intel, Live 0x0000000000000000',
        'nft_ct 24576 4 - Live 0x0000000000000000',
        '',
      ].join('\n'),
    }),
  ).toStrictEqual([
    'vm.swappiness = 60',
    'kernel.pid_max = 4194304',
    'vm.overcommit_memory = 0',
    'module kvm',
    'module kvm_intel',
    'module tun',
  ]);
});
