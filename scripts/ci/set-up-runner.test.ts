import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { createStubSudo } from '@impz/test-utils/create-stub-sudo';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-set-up-runner-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // PATH holds only the stand-ins' folder, so the host's own podman or modinfo never answers in
  // their place.
  const sudo = createStubSudo(directory);

  return { directoryPath: directory, sudo, scriptPath: join(import.meta.dir, 'set-up-runner.ts') };
}

test('it hands the cpu controller down to the containers, and shows what one gets', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'grep', 'exit 1');
  createStubBin(ctx.directoryPath, 'docker');

  const result = await $`${process.execPath} ${ctx.scriptPath} share-cpu`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'grep -qw cpu /sys/fs/cgroup/cgroup.subtree_control',
      'sudo tee /sys/fs/cgroup/cgroup.subtree_control',
      '< +cpu',
      'grep -qw cpu /sys/fs/cgroup/system.slice/cgroup.subtree_control',
      'sudo tee /sys/fs/cgroup/system.slice/cgroup.subtree_control',
      '< +cpu',
      'docker run --rm --cgroupns=private debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a cat /sys/fs/cgroup/cgroup.controllers',
      '',
    ].join('\n'),
  );
});

test('it writes nothing to a cgroup that hands the cpu controller down already', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'grep');
  createStubBin(ctx.directoryPath, 'docker');

  const result = await $`${process.execPath} ${ctx.scriptPath} share-cpu`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.sudo.calls, 'utf8')).not.toInclude('sudo tee');
});

test('it logs the refused write and still shows what a container gets, when the kernel refuses the cpu controller', async () => {
  const ctx = setupTest();

  createStubSudo(ctx.directoryPath, {
    refusedTees: ['/sys/fs/cgroup/system.slice/cgroup.subtree_control'],
  });

  createStubBin(ctx.directoryPath, 'grep', 'exit 1');
  createStubBin(ctx.directoryPath, 'docker');

  const result = await $`${process.execPath} ${ctx.scriptPath} share-cpu`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: 'tee: /sys/fs/cgroup/system.slice/cgroup.subtree_control: Invalid argument\n',
  });

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toInclude('docker run --rm --cgroupns=private');
});

test('it lets the error of a refused write reach the log', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'sudo', 'echo "tee: write error: Invalid argument" >&2\nexit 1');
  createStubBin(ctx.directoryPath, 'uname');

  const result = await $`${process.execPath} ${ctx.scriptPath} turn-on-ksm`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toStartWith('tee: write error: Invalid argument\n');
});

test('it turns KSM on with a high scan rate', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'uname', 'echo 6.17.0-1010-azure');
  createStubBin(ctx.directoryPath, 'grep');

  const result = await $`${process.execPath} ${ctx.scriptPath} turn-on-ksm`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'uname -r',
      'sudo tee /sys/kernel/mm/ksm/use_zero_pages',
      '< 1',
      'sudo tee /sys/kernel/mm/ksm/pages_to_scan',
      '< 1000',
      'sudo tee /sys/kernel/mm/ksm/run',
      '< 1',
      'grep -H . /sys/kernel/mm/ksm/run /sys/kernel/mm/ksm/pages_to_scan /sys/kernel/mm/ksm/use_zero_pages',
      '',
    ].join('\n'),
  );
});

test('it fails when the kernel refuses to turn KSM on', async () => {
  const ctx = setupTest();

  createStubSudo(ctx.directoryPath, { refusedTees: ['/sys/kernel/mm/ksm/run'] });
  createStubBin(ctx.directoryPath, 'uname');
  createStubBin(ctx.directoryPath, 'grep');

  const result = await $`${process.execPath} ${ctx.scriptPath} turn-on-ksm`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
});

test('it reserves 1 GiB of huge pages, and shows the pool and the userfaultfd device', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'grep', 'echo "HugePages_Total:     512"');
  createStubBin(ctx.directoryPath, 'stat');

  const result = await $`${process.execPath} ${ctx.scriptPath} reserve-huge-pages`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'HugePages_Total:     512\n',
  });

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'sudo tee /proc/sys/vm/nr_hugepages',
      '< 512',
      'grep -E ^HugePages_(Total|Free): /proc/meminfo',
      'stat -c %A %U %G %n /dev/userfaultfd',
      '',
    ].join('\n'),
  );
});

test('it reserves the number of huge pages it is given', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'grep');
  createStubBin(ctx.directoryPath, 'stat');

  const result = await $`${process.execPath} ${ctx.scriptPath} reserve-huge-pages 3072`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toStartWith(
    'sudo tee /proc/sys/vm/nr_hugepages\n< 3072\n',
  );
});

test('it names the e2e registry in /etc/hosts, after the entries there', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} name-e2e-registry`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    'sudo tee -a /etc/hosts\n< 10.200.0.1 imp-e2e-registry.test\n',
  );
});

test('it installs ZFS from the kernel modules that the runner has, with the ARC capped', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'modinfo');

  const result = await $`${process.execPath} ${ctx.scriptPath} install-zfs 1073741824`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'sudo apt-get update',
      'sudo apt-get install -y --no-install-recommends zfsutils-linux',
      'modinfo zfs',
      'sudo modprobe zfs zfs_arc_max=1073741824',
      'sudo tee /sys/module/zfs/parameters/zfs_arc_max',
      '< 1073741824',
      'sudo zfs version',
      '',
    ].join('\n'),
  );
});

test("it installs the kernel's extra modules when the runner lacks the zfs module, and leaves the ARC alone", async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'modinfo', 'exit 1');
  createStubBin(ctx.directoryPath, 'uname', 'echo 6.17.0-1010-azure');

  const result = await $`${process.execPath} ${ctx.scriptPath} install-zfs`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'sudo apt-get update',
      'sudo apt-get install -y --no-install-recommends zfsutils-linux',
      'modinfo zfs',
      'uname -r',
      'sudo apt-get install -y --no-install-recommends linux-modules-extra-6.17.0-1010-azure',
      'sudo modprobe zfs',
      'sudo zfs version',
      '',
    ].join('\n'),
  );
});

test('it installs Podman on a runner without it', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} install-podman`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'sudo apt-get update',
      'sudo apt-get install -y --no-install-recommends podman catatonit netavark aardvark-dns',
      'sudo podman --version',
      '',
    ].join('\n'),
  );
});

test('it keeps the Podman that the runner has', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'podman');

  const result = await $`${process.execPath} ${ctx.scriptPath} install-podman`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe('sudo podman --version\n');
});

test('it opens KVM to the nix builders through a udev rule', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} open-kvm-to-builders`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe(
    [
      'sudo tee /etc/udev/rules.d/99-kvm.rules',
      '< KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"',
      'sudo udevadm control --reload-rules',
      'sudo udevadm trigger --name-match=kvm',
      '',
    ].join('\n'),
  );
});

test('it refuses a task it does not know, with its usage', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} install-docker`
    .env({ PATH: ctx.directoryPath })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 2,
    stderr:
      'usage: set-up-runner.ts <share-cpu|turn-on-ksm|reserve-huge-pages|name-e2e-registry|install-zfs|install-podman|open-kvm-to-builders>\n',
  });
});

test('it refuses an argument that its task does not take, and sets nothing up', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} turn-on-ksm 1000`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 2,
    stderr:
      'usage: set-up-runner.ts <share-cpu|turn-on-ksm|reserve-huge-pages|name-e2e-registry|install-zfs|install-podman|open-kvm-to-builders>\n',
  });

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe('');
});

test('it refuses a second argument to install-zfs, and installs nothing', async () => {
  const ctx = setupTest();

  const result = await $`${process.execPath} ${ctx.scriptPath} install-zfs 1073741824 2147483648`
    .env({ PATH: ctx.sudo.bin })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 2,
    stderr:
      'usage: set-up-runner.ts <share-cpu|turn-on-ksm|reserve-huge-pages|name-e2e-registry|install-zfs|install-podman|open-kvm-to-builders> [arc max bytes]\n',
  });

  expect(readFileSync(ctx.sudo.calls, 'utf8')).toBe('');
});
