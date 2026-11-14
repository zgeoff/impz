import { expect, test } from 'bun:test';
import { pickKvmBlocker } from './pick-kvm-blocker.ts';

test('it finds no blocker on a host with KVM, Docker, a kernel and the host image', () => {
  const host = {
    hasKvm: true,
    hasDocker: true,
    kernelPath: '/w/imp/kernel/out/vmlinux',
    hasKernel: true,
    hostImage: 'imp-host:dev-imp-0a1b2c3d',
    hasHostImage: true,
  };

  expect(pickKvmBlocker(host)).toBeNull();
});

test.each([
  {
    missing: 'KVM',
    host: { hasKvm: false, hasDocker: true, hasKernel: true, hasHostImage: true },
    reason: /no \/dev\/kvm/u,
  },
  {
    missing: 'Docker',
    host: { hasKvm: true, hasDocker: false, hasKernel: true, hasHostImage: true },
    reason: /`docker info` fails/u,
  },
  {
    missing: 'the kernel',
    host: { hasKvm: true, hasDocker: true, hasKernel: false, hasHostImage: true },
    reason: /no guest kernel at \/w\/imp\/kernel\/out\/vmlinux; build it with kernel\/build\.sh/u,
  },
  {
    missing: 'the host image',
    host: { hasKvm: true, hasDocker: true, hasKernel: true, hasHostImage: false },
    reason: /no host image imp-host:dev-imp-0a1b2c3d; build it once with `IMP_DEV_NAME=wv-image/u,
  },
])('it names $missing as the blocker of a host without it', (row) => {
  const host = {
    ...row.host,
    kernelPath: '/w/imp/kernel/out/vmlinux',
    hostImage: 'imp-host:dev-imp-0a1b2c3d',
  };

  expect(pickKvmBlocker(host)).toMatch(row.reason);
});

test('it names KVM first on a host that lacks everything', () => {
  const host = {
    hasKvm: false,
    hasDocker: false,
    kernelPath: '/w/imp/kernel/out/vmlinux',
    hasKernel: false,
    hostImage: 'imp-host:dev-imp-0a1b2c3d',
    hasHostImage: false,
  };

  expect(pickKvmBlocker(host)).toMatch(/no \/dev\/kvm/u);
});
