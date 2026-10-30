import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { parseStepCommand } from '../lib/parse-step-command.ts';
import type { StepArgument } from '../lib/parse-step-command.ts';

interface Task {
  readonly stepArguments: readonly StepArgument[];
  readonly run: (args: readonly string[]) => Promise<void>;
}

// Each task sets up one thing on a throwaway GitHub-hosted runner, as root through sudo.
const tasks: Readonly<Record<string, Task>> = {
  'share-cpu': { stepArguments: [], run: shareCPUController },
  'turn-on-ksm': { stepArguments: [], run: turnOnKSM },
  'reserve-huge-pages': {
    stepArguments: [{ name: 'pages', isOptional: true }],
    run: reserveHugePages,
  },
  'name-e2e-registry': { stepArguments: [], run: nameE2ERegistry },
  'install-zfs': {
    stepArguments: [{ name: 'arc max bytes', isOptional: true }],
    run: installZfs,
  },
  'install-podman': { stepArguments: [], run: installPodman },
  'open-kvm-to-builders': { stepArguments: [], run: openKVMToBuilders },
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [name] = argv;
  const task = name !== undefined && Object.hasOwn(tasks, name) ? tasks[name] : undefined;

  const command = parseStepCommand(
    'set-up-runner.ts',
    [{ name: 'task', choices: Object.keys(tasks) }, ...(task?.stepArguments ?? [])],
    argv,
  );

  if (!command.isValid) {
    console.error(command.usage);

    process.exitCode = 2;

    return;
  }

  invariant(task, 'the parser accepts only a listed task');

  await task.run(command.values.slice(1));
}

// The cpu suite fails in CI unless a private cgroup namespace gets the cpu controller, and Docker's
// containers live under system.slice. A refused write is left for the cpu suite to report, after
// the task shows what a container gets, on host/Dockerfile's runtime base, pinned the same.
async function shareCPUController(): Promise<void> {
  const controls = [
    '/sys/fs/cgroup/cgroup.subtree_control',
    '/sys/fs/cgroup/system.slice/cgroup.subtree_control',
  ];

  for (const control of controls) {
    const listed = await $`grep -qw cpu ${control}`.nothrow();

    if (listed.exitCode !== 0) {
      // tee's stderr already reached the log, so the rejection carries nothing more to report
      await writeAsRoot(control, '+cpu\n').catch(() => {});
    }
  }

  await $`docker run --rm --cgroupns=private debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a cat /sys/fs/cgroup/cgroup.controllers`.nothrow();
}

// KSM is global to the kernel, so only a runner's own VM turns it on. The scan rate is high so
// merges come in minutes.
async function turnOnKSM(): Promise<void> {
  await $`uname -r`;
  await writeAsRoot('/sys/kernel/mm/ksm/use_zero_pages', '1\n');
  await writeAsRoot('/sys/kernel/mm/ksm/pages_to_scan', '1000\n');
  await writeAsRoot('/sys/kernel/mm/ksm/run', '1\n');
  await $`grep -H . /sys/kernel/mm/ksm/run /sys/kernel/mm/ksm/pages_to_scan /sys/kernel/mm/ksm/use_zero_pages`;
}

// 512 pages of 2 MiB by default: enough for the huge-pages suite's imps one at a time and a
// template build beside one.
async function reserveHugePages(args: readonly string[]): Promise<void> {
  const [pages = '512'] = args;

  await writeAsRoot('/proc/sys/vm/nr_hugepages', `${pages}\n`);
  await $`grep -E ${'^HugePages_(Total|Free):'} /proc/meminfo`;
  await $`stat -c ${'%A %U %G %n'} /dev/userfaultfd`;
}

// The registry suite's registry listens under this name on the gateway of its own Docker network
// (packages/e2e-harness/src/registry-plan.ts, port offset 0), which both this host's engine and
// impd's builders reach.
async function nameE2ERegistry(): Promise<void> {
  await $`sudo tee -a /etc/hosts < ${new Response('10.200.0.1 imp-e2e-registry.test\n')}`;
}

// zfs.ko sits in linux-modules-extra on some runner kernels. The optional argument caps the ARC in
// bytes, which defaults to half of RAM.
async function installZfs(args: readonly string[]): Promise<void> {
  const [arcMaxBytes] = args;

  await $`sudo apt-get update`;
  await $`sudo apt-get install -y --no-install-recommends zfsutils-linux`;

  const module = await $`modinfo zfs`.nothrow().quiet();

  if (module.exitCode !== 0) {
    const kernel = await $`uname -r`.text();

    await $`sudo apt-get install -y --no-install-recommends ${`linux-modules-extra-${kernel.trim()}`}`;
  }

  if (arcMaxBytes === undefined) {
    await $`sudo modprobe zfs`;
  } else {
    await $`sudo modprobe zfs ${`zfs_arc_max=${arcMaxBytes}`}`;
    await writeAsRoot('/sys/module/zfs/parameters/zfs_arc_max', `${arcMaxBytes}\n`);
  }

  // zfsutils 2.2.2-0ubuntu9.5 and later refuse to run as a user
  await $`sudo zfs version`;
}

async function installPodman(): Promise<void> {
  if (Bun.which('podman') === null) {
    await $`sudo apt-get update`;
    await $`sudo apt-get install -y --no-install-recommends podman catatonit netavark aardvark-dns`;
  }

  await $`sudo podman --version`;
}

// The nix daemon builds as the nixbld users, who must open /dev/kvm.
async function openKVMToBuilders(): Promise<void> {
  await writeAsRoot(
    '/etc/udev/rules.d/99-kvm.rules',
    'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\n',
  );

  await $`sudo udevadm control --reload-rules`;
  await $`sudo udevadm trigger --name-match=kvm`;
}

// tee echoes what it writes, so only its stdout is dropped and an error reaches the log. Bun's
// shell takes one redirect per command, so the write spawns tee with its stdio set.
async function writeAsRoot(path: string, text: string): Promise<void> {
  const tee = Bun.spawn(['sudo', 'tee', path], {
    stdin: Buffer.from(text),
    stdout: 'ignore',
    stderr: 'inherit',
  });

  const exitCode = await tee.exited;

  if (exitCode !== 0) {
    throw new Error(`sudo tee ${path} exited with ${String(exitCode)}`);
  }
}

if (import.meta.main) {
  await main();
}
