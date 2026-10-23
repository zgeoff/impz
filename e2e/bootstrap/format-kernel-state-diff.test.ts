import { expect, test } from 'bun:test';
import { formatKernelStateDiff } from './format-kernel-state-diff';

test('it marks each line that went with < and each line that came with >', () => {
  expect(
    formatKernelStateDiff({
      before: ['vm.swappiness = 60', 'kernel.pid_max = 4194304', 'module kvm'],
      after: ['vm.swappiness = 10', 'kernel.pid_max = 4194304', 'module kvm', 'module tun'],
    }),
  ).toBe('< vm.swappiness = 60\n> vm.swappiness = 10\n> module tun\n');
});

test('it gives no lines for equal states', () => {
  expect(formatKernelStateDiff({ before: ['module kvm'], after: ['module kvm'] })).toBe('');
});
