import type { SystemInfo } from '@impz/api';
import { jsonArg } from '../args/common-args';
import { defineCommand } from '../cli/define-command';
import { runAction } from '../cli/run-action';
import { formatImpInfo } from '../output/format-imp-info';
import { formatBootStatus, formatHttps, formatJson } from '../output/format-output';

export const infoCommand = defineCommand({
  name: 'info',
  description: 'Show impd version, RAM budget and counts, or one imp with its container',
  args: {
    name: { type: 'positional', description: 'an imp to show instead of impd', required: false },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const name = ctx.values.name;

      if (name !== undefined) {
        const imp = await client.imps.get({ name });

        const shown = ctx.values.json === true ? formatJson(imp) : formatImpInfo(imp);

        ctx.extensions.impz.io.print(shown);

        return;
      }

      const info = await client.system.info();

      if (ctx.values.json === true) {
        ctx.extensions.impz.io.print(formatJson(info));

        return;
      }

      const lines = [
        ['version', info.version],
        ['imps', `${String(info.impCount)} (${String(info.awakeCount)} awake)`],
        ['sessions', String(info.sessionCount)],
        ['boot status', formatBootStatus(info.bootStatus, info.version)],
        [
          'ram',
          `${String(info.ramUsedMib)} / ${String(info.ramBudgetMib)} MiB (${String(info.ramReservedMib)} reserved, ${String(info.ramCommittedMib)} committed${formatSleeping(info.ramSleepingMib)})`,
        ],
        ['firecracker', info.firecrackerVersion ?? 'unknown'],
        [
          'kernel',
          `${info.guestKernel.version ?? 'unknown'} (sha256 ${info.guestKernel.sha256.slice(0, 12)})`,
        ],
        ['agent drive', `sha256 ${info.systemDrive.sha256.slice(0, 12)}`],
        [
          'storage',
          `${info.storage.backend}, ${formatGib(info.storage.usedBytes)} used, ${formatGib(info.storage.availableBytes)} free, ${formatGib(info.storage.reserveBytes)} reserved${info.storage.isLow ? ' (LOW)' : ''}`,
        ],
        [
          'disks',
          `${formatGib(info.storage.impDiskBytes)} given to imps, of ${formatGib(info.storage.usedBytes + info.storage.availableBytes)}`,
        ],
        ...formatDefaults(info.defaults),
        ...formatEgress(info.egress),
        ...formatLimits(info.cpu),
        ...formatKsm(info.ksm),
        ['tailscale', info.tailscale.enabled ? (info.tailscale.state ?? 'enabled') : 'disabled'],
        ...formatTailnetNames(info.tailscale.names),
        ...formatHttps(info.https),
        ['public', formatPublic(info.public)],
      ];

      for (const [label = '', value = ''] of lines) {
        ctx.extensions.impz.io.print(`${label.padEnd(12)}${value}`);
      }
    }),
});

function formatSleeping(mib: number | undefined): string {
  return mib === undefined ? '' : `, ${String(mib)} asleep`;
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatDefaults(defaults: SystemInfo['defaults']): string[][] {
  if (defaults === undefined) {
    return [];
  }

  return [['defaults', `${String(defaults.memoryMib)} MiB, image ${defaults.image ?? '(none)'}`]];
}

function formatEgress(egress: SystemInfo['egress']): string[][] {
  if (egress === undefined) {
    return [];
  }

  return [
    [
      'egress',
      egress.isEnforced
        ? 'public, box and none policies enforced'
        : 'public, box and none policies not enforced',
    ],
  ];
}

function formatLimits(cpu: SystemInfo['cpu']): string[][] {
  if (cpu === undefined) {
    return [];
  }

  return [
    [
      'limits',
      cpu.limitsEnforced
        ? 'cpu limits enforced'
        : 'OFF: no cpu or memory limits, no delegated cgroup (setup-cgroups.sh in the container log); jailed VMs cannot start',
    ],
  ];
}

function formatKsm(ksm: SystemInfo['ksm']): string[][] {
  if (ksm === null || ksm === undefined) {
    return [];
  }

  const state = ksm.running ? 'merging' : 'ksmd stopped';
  const unmergeable = ksm.unmergeable > 0 ? `, ${String(ksm.unmergeable)} imps unmergeable` : '';

  return [
    [
      'ksm',
      `${state}, ${String(ksm.sharedMib)} MiB shared (profit ${String(ksm.profitMib)} MiB), ${String(ksm.headroomMib)} MiB headroom${unmergeable}`,
    ],
  ];
}

function formatTailnetNames(names: SystemInfo['tailscale']['names']): string[][] {
  if (names === null) {
    return [];
  }

  return [
    ['names', `${String(names.live)} live, ${String(names.failed.length)} failed`],
    ...names.failed.map((failure) => ['', `${failure.name}: ${failure.error}`]),
  ];
}

function formatPublic(info: SystemInfo['public']): string {
  if (info === undefined) {
    return 'unknown';
  }

  if (info === null) {
    return 'off (IMP_PUBLIC_IP unset)';
  }

  const records = info.records;
  const at = records?.at.toISOString() ?? '';
  let state = 'records not written yet';

  if (records !== null) {
    state = records.isOk
      ? `records ok at ${at}`
      : `records failing at ${at}: ${records.error ?? ''}`;
  }

  return `${String(info.imps)} imps at ${info.ip}, ${state}`;
}
