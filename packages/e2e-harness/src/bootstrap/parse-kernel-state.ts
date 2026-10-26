// Counters and values that move on their own are left out. Of the modules, only the ones
// bootstrap.sh would load: the kernel loads others (nft_ct, xfs, the socket diag modules) on demand
// when the container uses them.
const MOVING_SYSCTL =
  /^kernel\.(?:random\.|spl\.kmem\.|ns_last_pid|pty\.nr|sched_domain\.|perf_event_max_sample_rate|tainted)/u;

const BOOTSTRAP_MODULES: ReadonlySet<string> = new Set([
  'kvm',
  'kvm_intel',
  'kvm_amd',
  'tun',
  'loop',
  'zfs',
]);

interface KernelStateSources {
  readonly sysctl: string;
  readonly modules: string;
}

export function parseKernelState(sources: KernelStateSources): readonly string[] {
  const sysctls = sources.sysctl
    .split('\n')
    .filter((line) => /^(?:vm|kernel)\./u.test(line) && !MOVING_SYSCTL.test(line));

  const modules = sources.modules
    .split('\n')
    .map((line) => line.split(' ')[0] ?? '')
    .filter((name) => BOOTSTRAP_MODULES.has(name))
    .map((name) => `module ${name}`)
    .toSorted();

  return [...sysctls, ...modules];
}
