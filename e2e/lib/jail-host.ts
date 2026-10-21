import { VmIdentitySchema } from '../../packages/daemon/src/vm/sleep/vm-identity';
import { buildTemplateKey } from '../../packages/daemon/src/vm/templates/boot-templates';
import { requireImp } from './imp-cli';
import { runInContainer } from './instance';

export interface JailState {
  readonly impId: string;

  readonly cmdline: string;
  readonly uid: string;
  readonly capEff: string;

  // Firecracker installs its seccomp filters per thread.
  readonly seccompModes: readonly string[];

  readonly tapOwner: string;

  readonly sealedOwners: readonly string[];
}

export function readStatusField(status: string, field: string): string {
  return new RegExp(`^${field}:\\s+(?<value>.*)$`, 'mv').exec(status)?.groups?.['value'] ?? '';
}

export function collectJailViolations(state: Readonly<JailState>): readonly string[] {
  const checks: readonly (readonly [boolean, string])[] = [
    [state.cmdline.startsWith(`/firecracker --id ${state.impId} `), 'not started by the jailer'],
    [
      state.cmdline.includes(`--api-sock /var/lib/imp/imps/${state.impId}/run/api.sock`),
      'another API socket',
    ],
    [Number(state.uid) >= 900_000, `uid ${state.uid}`],
    [state.capEff === '0000000000000000', `capabilities ${state.capEff}`],
    [state.seccompModes.length > 1, `${String(state.seccompModes.length)} threads`],
    [state.seccompModes.every((mode) => mode === '2'), `seccomp ${state.seccompModes.join(',')}`],
    [state.tapOwner === state.uid, `tap owned by ${state.tapOwner}`],
    [
      state.sealedOwners.join(',') === '0,0',
      `run/ and snapshot/ owned by ${state.sealedOwners.join(',')}`,
    ],
  ];

  return checks.filter(([isKept]) => !isKept).map(([, violation]) => violation);
}

export function hasTemplateBuildEnded(log: string, name: string, key: string): boolean {
  const ended = new RegExp(
    `impd: boot template ${key.slice(0, 12)} (?:built in|build refused|build failed)`,
    'v',
  );

  return log.includes(`${name}: restored boot template`) || ended.test(log);
}

async function readContainerText(path: string): Promise<string> {
  const result = await runInContainer(['cat', path]);

  if (result.exitCode !== 0) {
    throw new Error(`cat ${path} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

export interface VmProcess {
  readonly pid: string;
  readonly cmdline: string;
  readonly status: string;
}

export async function readVmProcess(name: string): Promise<VmProcess> {
  const row = await requireImp(name);
  const found = await runInContainer(['pgrep', '-f', `firecracker.*imps/${row.id}/`]);

  const pid = found.stdout.split('\n')[0]?.trim() ?? '';

  if (pid === '') {
    throw new Error(`no firecracker for ${name}`);
  }

  const cmdline = await readContainerText(`/proc/${pid}/cmdline`);
  const status = await readContainerText(`/proc/${pid}/status`);

  return { pid, cmdline: cmdline.replaceAll('\0', ' '), status };
}

export async function readTemplateKey(name: string): Promise<string> {
  const row = await requireImp(name);
  const result = await runInContainer(['cat', `/var/lib/imp/imps/${row.id}/vm.json`]);

  if (result.exitCode !== 0) {
    throw new Error(`${name}'s vm.json: ${result.stderr.trim()}`);
  }

  const identity = VmIdentitySchema.required({ cpuModel: true, cpuFlags: true }).parse(
    JSON.parse(result.stdout),
  );

  return buildTemplateKey(identity, { vcpus: row.vcpus, memoryMib: row.memoryMib });
}

export async function readJailState(name: string): Promise<JailState> {
  const row = await requireImp(name);
  const vm = await readVmProcess(name);

  const modes = await runInContainer([
    'sh',
    '-c',
    `grep -h '^Seccomp:' /proc/${vm.pid}/task/*/status | awk '{print $2}'`,
  ]);

  const tapOwner = await readContainerText(`/sys/class/net/imp${String(row.slot)}/owner`);

  const sealed = await runInContainer([
    'stat',
    '-c',
    '%u',
    `/var/lib/imp/imps/${row.id}/run`,
    `/var/lib/imp/imps/${row.id}/snapshot`,
  ]);

  return {
    impId: row.id,
    cmdline: vm.cmdline,
    uid: readStatusField(vm.status, 'Uid').split(/\s+/v)[0] ?? '',
    capEff: readStatusField(vm.status, 'CapEff'),
    seccompModes: modes.stdout.trim().split('\n'),
    tapOwner,
    sealedOwners: sealed.stdout.trim().split('\n'),
  };
}

export async function readImpCgroupText(name: string, file: string): Promise<string> {
  const row = await requireImp(name);

  return readContainerText(`/sys/fs/cgroup/imps/${row.id}/${file}`);
}

export async function listJailMounts(directory: string): Promise<readonly string[]> {
  const mounts = await readContainerText('/proc/self/mounts');

  return mounts.split('\n').filter((line) => line.includes(` /var/lib/imp/jail/${directory}`));
}
